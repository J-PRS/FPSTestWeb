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

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const arg = (k: string, d = ''): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i !== -1 ? process.argv[i + 1] ?? '1' : d;
};
const PORT = Number.parseInt(arg('port', '8001'), 10);
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

function taskkill(pid: number): void {
  spawnSync('taskkill', ['/F', '/PID', String(pid)]);
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function metrics(port: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {return null;}
    return await r.json() as Record<string, unknown>;
  } catch { return null; }
}

async function wireKinds(port: number): Promise<Record<string, number> | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/wire`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {return null;}
    const j = await r.json() as { rxByKind?: Record<string, { bytes?: number }> };
    return j.rxByKind ?? null;
  } catch { return null; }
}

/** Server CPU% of one core over `secs` wall — (CPU time delta)/wall. */
async function cpuPct(pid: number, secs: number): Promise<number> {
  const cpuOf = (p: number): number => {
    const out = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${p}).CPU`]).stdout.toString().trim();
    return Number.parseFloat(out) || 0;
  };
  const a = cpuOf(pid);
  await sleep(secs * 1000);
  const b = cpuOf(pid);
  return ((b - a) / secs) * 100;
}

const serverLog = `_tools/devin_scratch/profload_server.log`;

/** `--sweep`: kill every lingering netBot bun process and exit — the
 *  zombie reaper for all the sessions that died without finally. */
if (process.argv.includes('--sweep')) {
  const out = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"name='bun.exe'\" | Where-Object { $_.CommandLine -match 'netBot' } | Select-Object -ExpandProperty ProcessId"],
  ).stdout.toString();
  const pids = [...new Set(out.match(/\d+/g) ?? [])].map(Number).filter(p => p !== process.pid);
  for (const pid of pids) {taskkill(pid);}
  console.log(`[profload] swept ${pids.length} netBot processes`);
  process.exit(0);
}

let serverPid = 0;
let measured = -1;
try {
  if (!ATTACH) {
    // Preflight: free the port — holders are stale servers from prior
    // rounds (the only legitimate :PORT listeners we spawn are ours).
    for (const pid of portHolders(PORT)) {
      log(`killing stale :${PORT} holder pid=${pid}`);
      taskkill(pid);
    }
    await sleep(1200);

    const file = Bun.file(serverLog);
    const srv = Bun.spawn(
      [...(CPUPROF ? [BUN, '--cpu-prof'] : [BUN]), 'src/server.ts'],
      {
        cwd: 'server_bun',
        env: { ...process.env, FPS_PORT: String(PORT), FPS_NO_WT: '1' },
        stdout: file,
        stderr: file,
        stdin: 'ignore',
      },
    );
    kids.push(srv);
    serverPid = srv.pid;
    log(`server pid=${serverPid} (cpuprof=${CPUPROF}) — waiting for /health`);
    const t0 = Date.now();
    while (!(await healthOk(PORT))) {
      if (Date.now() - t0 > 20000) {throw new Error('server never came up — see ' + serverLog);}
      if (srv.exitCode !== null) {throw new Error(`server exited ${srv.exitCode} — see ${serverLog}`);}
      await sleep(500);
    }
    log('server up');
  } else {
    serverPid = portHolders(PORT)[0] ?? 0;
    if (!serverPid) {throw new Error(`no :${PORT} listener to attach to`);}
    log(`attached to :${PORT} server pid=${serverPid}`);
  }

  // Load: N bots spread across rooms, one netBot proc per room.
  const per = Math.ceil(BOTS / ROOMS.length);
  for (const room of ROOMS) {
    const blog = Bun.file(`_tools/devin_scratch/profload_${room}.log`);
    kids.push(Bun.spawn(
      [BUN, 'tools/netBot.ts', '--bots', String(per), '--room', room, '--mode', 'dm', '--net', 'ws', '--url', `ws://localhost:${PORT}/ws`],
      { cwd: 'server_bun', stdout: blog, stderr: blog, stdin: 'ignore' },
    ));
  }
  log(`${BOTS} bots across ${ROOMS.length} rooms — settling ${SETTLE}s`);
  await sleep(SETTLE * 1000);

  const m0 = await metrics(PORT);
  const players = (m0 as { players?: number } | null)?.players ?? 0;
  log(`players=${players} — measuring ${SECS}s`);
  measured = await cpuPct(serverPid, SECS);
  const m1 = await metrics(PORT);

  const rx = await wireKinds(PORT);
  const bw = (m1 as { bandwidth?: { tickMs?: { avg?: number; max?: number }; phaseMs?: Record<string, number>; tickFramesDroppedPerSec?: number; tickFramesHeldPerSec?: number } } | null)?.bandwidth;
  if (rx) {log(`rxByKind: ${JSON.stringify(rx)}`);}
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
      await fetch(`http://127.0.0.1:${PORT}/dev/shutdown`, { signal: AbortSignal.timeout(3000) });
      await sleep(4000); // flush window
      const profs = readdirSync('server_bun').filter(f => f.endsWith('.cpuprofile')).sort();
      log(`profile: server_bun/${profs[profs.length - 1]}`);
    } catch { /* shutdown raced the kill below — non-fatal */ }
  }
  if (!KEEP) {killAll('done');}
  else {log(`--keep: leaving ${kids.length} children running`);}
}
