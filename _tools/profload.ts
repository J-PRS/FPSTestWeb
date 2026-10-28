/** profload — one-command server CPU profile under real-socket load.
 *
 *  Why this exists: every prior profile round leaked netBot/server
 *  zombies that contaminated the next measurement, and `--cpu-prof`
 *  needed a graceful shutdown to flush. This runner tracks every child
 *  it spawns and kills them in `finally` — zombies are impossible.
 *
 *  Usage:
 *    bun _tools/devin_scratch/profload.ts --bots 64 --rooms prof1,prof2
 *    bun _tools/devin_scratch/profload.ts --bots 64 --cpuprof --secs 60
 *    bun _tools/devin_scratch/profload.ts --attach 8001 --secs 30   # measure a live server only
 *
 *  Env: FPS_PORT (default 8001) FPS_MAP (optional map override).
 */

import { readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const arg = (k: string, d = ''): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i !== -1 ? process.argv[i + 1] ?? '1' : d;
};
// Port: explicit --port pins (preflight kills its holders). Default is a
// free port scanned from 8100 — a run can NEVER race a pre-existing dev
// server on :8000 or a leftover profload server on :8001.
const PINNED = arg('port', '');
const BOTS = Number.parseInt(arg('bots', '64'), 10);
const ROOMS = arg('rooms', 'prof1,prof2').split(',');
const SECS = Number.parseInt(arg('secs', '60'), 10);
const SETTLE = Number.parseInt(arg('settle', '18'), 10);
const CPUPROF = process.argv.includes('--cpuprof');
const ATTACH = process.argv.includes('--attach');
const KEEP = process.argv.includes('--keep');
const BUN = process.execPath; // the bun binary running this script

const kids: ReturnType<typeof Bun.spawn>[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (s: string) => console.log(`[profload] ${s}`);

function killAll(reason: string): void {
  for (const p of kids) {
    try { if (p.exitCode === null) {p.kill();} } catch { /* already gone */ }
  }
  if (kids.length > 0) {log(`killed ${kids.length} children (${reason})`);}
}

/** PIDs of processes holding a LISTEN socket on the port (netstat). */
function portHolders(port: number): number[] {
  const out = spawnSync('netstat', ['-ano', '-p', 'tcp']).stdout.toString();
  return [...new Set([...out.matchAll(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'g'))].map(m => +m[1]!))];
}

// Run identity: the spawned server echoes this token on /health — a
// stale listener answering the port can never pass as ours.
const BOOT = `pl${process.pid.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
// Port list: --port pins one; default scans 8100+ (netstat misses
// half-bound/TIME_WAIT holders, so the spawn loop below also retries
// the next port when the server exits before answering /health).
let PORT = ATTACH ? Number.parseInt(arg('attach', '8001'), 10)
  : PINNED ? Number.parseInt(PINNED, 10) : 0;

/** Track a spawned child + log mid-run exits — a crashed bot/server
 *  was previously invisible (players quietly drained to 0). */
let DONE = false;
function track(p: ReturnType<typeof Bun.spawn>, tag: string): void {
  kids.push(p);
  if (p.exited) {void p.exited.then((c): void => { if (!DONE) {log(`${tag} pid=${p.pid} exited code=${c} mid-run`);} });}
}

function taskkill(pid: number): void {
  spawnSync('taskkill', ['/F', '/PID', String(pid)]);
}

async function healthOk(port: number, boot?: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) {return false;}
    if (boot === undefined) {return true;}
    return ((await r.json()) as { boot?: string | null }).boot === boot;
  } catch { return false; }
}

const KEY = process.env.FPS_ADMIN_TOKEN ?? 'plkey';

async function metrics(port: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/metrics?key=${KEY}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {return null;}
    return await r.json() as Record<string, unknown>;
  } catch { return null; }
}

async function wireKinds(port: number): Promise<{ rx: Record<string, number> | null; tx: Record<string, number> | null } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/wire?key=${KEY}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {return null;}
    const j = await r.json() as { rxByKind?: Record<string, { bytes?: number }>; txByKind?: Record<string, { bytes?: number }> };
    return { rx: j.rxByKind ?? null, tx: j.txByKind ?? null };
  } catch { return null; }
}

/** Server CPU% of one core over `secs` wall — (CPU time delta)/wall.
 *  Aborts when the measured process dies mid-window: a dead server's
 *  delta reads as a negative/garbage number, not a measurement. */
async function cpuPct(pid: number, secs: number, srv?: ReturnType<typeof Bun.spawn>): Promise<number> {
  const cpuOf = (p: number): number => {
    const out = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${p}).CPU`]).stdout.toString().trim();
    return Number.parseFloat(out) || 0;
  };
  const a = cpuOf(pid);
  const deadline = secs * 1000;
  const t0 = Date.now();
  while (Date.now() - t0 < deadline) {
    if (srv && srv.exitCode !== null) {throw new Error(`server exited ${srv.exitCode} mid-measurement — see ${serverLog}`);}
    await sleep(250);
  }
  const b = cpuOf(pid);
  return ((b - a) / secs) * 100;
}

const serverLog = `_tools/devin_scratch/profload_server.log`;

/** `--sweep`: kill every lingering netBot bun process AND every server
 *  holding a port in the run range (8100-8199) — zombies from sessions
 *  that died without finally. :8000 dev servers are out of range by
 *  construction and never touched. */
if (process.argv.includes('--sweep')) {
  const out = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"name='bun.exe'\" | Where-Object { $_.CommandLine -match 'netBot' } | Select-Object -ExpandProperty ProcessId"],
  ).stdout.toString();
  const pids = [...new Set(out.match(/\d+/g) ?? [])].map(Number).filter(p => p !== process.pid);
  for (const pid of pids) {taskkill(pid);}
  let portKills = 0;
  for (let p = 8100; p < 8200; p++) {for (const pid of portHolders(p)) {taskkill(pid); portKills += 1;}}
  console.log(`[profload] swept ${pids.length} netBot processes, ${portKills} stale 81xx servers`);
  process.exit(0);
}

let serverPid = 0;
let measured = -1;
let srv: ReturnType<typeof Bun.spawn> | null = null;
try {
  if (!ATTACH) {
    // Preflight on a PINNED port only — holders are stale servers from
    // prior rounds. An auto-picked port is already free by construction.
    if (PINNED) {
      for (const pid of portHolders(PORT)) {
        log(`killing stale :${PORT} holder pid=${pid}`);
        taskkill(pid);
      }
      await sleep(1200);
    }

    const argv = [BUN, ...(CPUPROF ? ['--cpu-prof'] : []), ...(arg('preload', '') ? ['--preload', arg('preload')] : []), 'src/server.ts'];
    // Retry on successive ports — a holder that slips between the scan
    // and the bind (or a TIME_WAIT ghost netstat misses) is skipped, not fatal.
    for (let p = PORT || 8100; p < 8200; p++) {
      PORT = p;
      // Per-port log — a shared file clobbers the failed attempt's exit
      // reason (observed: 8100 died code=1, its log was never preserved).
      const attemptLog = serverLog.replace(/\.log$/, `_${p}.log`);
      try { unlinkSync(attemptLog); } catch { /* none yet */ }
      const file = Bun.file(attemptLog);
      srv = Bun.spawn(argv,
        {
          cwd: 'server_bun',
          env: { ...process.env, FPS_PORT: String(PORT), FPS_NO_WT: '1', FPS_BOOT: BOOT, FPS_ADMIN_TOKEN: KEY },
          stdout: file,
          stderr: file,
          stdin: 'ignore',
        },
      );
      track(srv, 'server');
      serverPid = srv.pid;
      log(`server pid=${serverPid} (cpuprof=${CPUPROF}, port=${PORT}) — waiting for /health`);
      const t0 = Date.now();
      while (!(await healthOk(PORT, BOOT))) {
        if (srv.exitCode !== null) {break;}
        if (Date.now() - t0 > 20000) {throw new Error('server never came up — see ' + attemptLog);}
        await sleep(500);
      }
      if (await healthOk(PORT, BOOT)) {break;}
      if (!PINNED) {log(`port ${PORT} failed (server exited ${srv.exitCode}) — trying next`); continue;}
      throw new Error(`server exited ${srv.exitCode} — see ${attemptLog}`);
    }
    if (!(await healthOk(PORT, BOOT))) {throw new Error('no bindable port — see _tools/devin_scratch/profload_server_*.log');}
    log('server up');
  } else {
    serverPid = portHolders(PORT)[0] ?? 0;
    if (!serverPid) {throw new Error(`no :${PORT} listener to attach to`);}
    log(`attached to :${PORT} server pid=${serverPid}`);
  }

  // wideSoak is the live driver (server_bun/tools/netBot.ts was retired):
  // one proc, --rooms N --bots PER. Loopback is throttle-exempt, so pace 5ms.
  track(Bun.spawn(
    [BUN, '../tools/netbot/wideSoak.ts', '--rooms', String(ROOMS.length), '--bots', String(Math.ceil(BOTS / ROOMS.length)),
      '--seconds', String(SETTLE + SECS + 30), '--pace', '5', '--url', `ws://localhost:${PORT}/ws`, '--roombase', ROOMS[0] ?? 'prof'],
    { cwd: 'server_bun', stdout: Bun.file(`_tools/devin_scratch/profload_rooms.log`), stderr: Bun.file(`_tools/devin_scratch/profload_rooms.log`), stdin: 'ignore' },
  ), 'netBot');
  log(`${BOTS} bots across ${ROOMS.length} rooms — settling ${SETTLE}s`);
  await sleep(SETTLE * 1000);

  const m0 = await metrics(PORT);
  const players = (m0 as { players?: number } | null)?.players ?? 0;
  if (players < Math.ceil(BOTS * 0.75)) {log(`WARNING players=${players} < expected ${BOTS} — bots died or never joined (see profload_*.log); measurement is suspect`);}
  log(`players=${players} — measuring ${SECS}s`);
  measured = await cpuPct(serverPid, SECS, srv);
  const m1 = await metrics(PORT);

  const rx = await wireKinds(PORT);
  const bw = (m1 as { bandwidth?: { tickMs?: { avg?: number; max?: number }; phaseMs?: Record<string, number>; tickFramesDroppedPerSec?: number; tickFramesHeldPerSec?: number } } | null)?.bandwidth;
  if (rx) {log(`rxByKind: ${JSON.stringify(rx.rx)}\ntxByKind: ${JSON.stringify(rx.tx)}`);}
  console.log(JSON.stringify({
    cpuPct: +measured.toFixed(1),
    players: (m1 as { players?: number } | null)?.players ?? players,
    tickMsAvg: bw?.tickMs?.avg,
    tickMsMax: bw?.tickMs?.max,
    dropped: bw?.tickFramesDroppedPerSec,
    held: bw?.tickFramesHeldPerSec,
    phaseMs: bw?.phaseMs,
    perClientCorePct: players ? +(measured / players).toFixed(3) : null,
    ccuPerCore: players ? +(100 / (measured / players)).toFixed(0) : null,
  }, null, 1));
} finally {
  if (CPUPROF && !ATTACH) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/dev/shutdown?key=${KEY}`, { signal: AbortSignal.timeout(3000) });
      // Wait for actual exit — the cpuprofile flushes on process end, and a
      // fixed window raced killAll below (observed: boot-only profiles).
      for (let i = 0; i < 75 && srv && srv.exitCode === null; i++) {await sleep(200);}
      const profs = readdirSync('server_bun').filter(f => f.endsWith('.cpuprofile')).sort();
      log(`profile: server_bun/${profs[profs.length - 1]}`);
    } catch { /* shutdown raced the kill below — non-fatal */ }
  }
  DONE = true;
  if (!KEEP) {killAll('done');}
  else {log(`--keep: leaving ${kids.length} children running`);}
}
