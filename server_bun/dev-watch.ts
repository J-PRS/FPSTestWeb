// oxlint-disable no-console,no-void -- CLI script: console is the output
// channel, void marks intentional fire-and-forget promises.
/**
 * Dev runner: `bun dev-watch.ts` — bun's own --watch only follows imports
 * under its entry dir, so shared/ changes never restart the server even
 * though they're protocol-critical. This wrapper spawns the server and
 * restarts the child when any file under ../shared (or ./src) changes.
 *
 * Debounced: saves that touch many files (formatter, branch switch)
 * collapse into one restart.
 */
import { spawn, type Subprocess } from 'bun';
import { watch } from 'fs';
import { execFileSync } from 'node:child_process';

const DIRS = ['src', '../shared'];
const DEBOUNCE_MS = 5000; // was 150, then 1000, then 30000 — 5s batches a quick edit burst into one restart while staying snappy for dev iteration

const say = (s: string): void => { // oxlint-disable-next-line no-console
  console.log(`[35m${s}[0m`);
};

let child: Subprocess | null = null;
let restarting = false;
let pending = false;

const PORT = Number(process.env.FPS_PORT) || 8000;
const STATE_PORT = PORT + 1;
const STATE_URL = `http://127.0.0.1:${STATE_PORT}/state`;

// In-memory seat carryover: the child PUTs its player seats on graceful
// shutdown and GETs them back on boot — restarts keep players where they
// were with no disk writes. The blob dies with the watcher, which is
// also exactly when you want a clean slate.
let savedState: unknown = null;
// Armed restart deadline — the client polls /restart so its dev HUD can
// count down "server restart in Ns" during debounce+drain instead of the
// socket dying as a surprise. 0 = nothing pending.
let restartAt = 0;
try {
  Bun.serve({
    port: STATE_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      // Cross-origin: the dev client lives on vite :5400, this on :PORT+1.
      if (url.pathname === '/restart') {
        return Response.json({ restartAt }, { headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      if (url.pathname !== '/state') {return new Response('not found', { status: 404 });}
      if (req.method === 'PUT') {
        savedState = await req.json().catch(() => null);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'GET') {
        return savedState ? Response.json(savedState) : new Response('empty', { status: 404 });
      }
      return new Response(null, { status: 405 });
    },
  });
  say(`[dev-watch] seat handoff on :${STATE_PORT} (in-memory)`);
} catch {
  say(`[dev-watch] seat handoff unavailable — :${STATE_PORT} busy, restarts re-spawn at base`);
}

let bootAt = 0;
let lastBootAt = 0;
let bindFails = 0;
let conflictBusy = false;

function boot(): void {
  // Cooldown: don't spawn a new child within 3s of the last boot.
  // Prevents rapid respawn loops when the port is busy (TIME_WAIT)
  // or the watcher fires repeatedly during active editing.
  const now = Date.now();
  if (now - lastBootAt < 3000) {
    setTimeout(boot, 3000 - (now - lastBootAt));
    return;
  }
  lastBootAt = now;
  bootAt = now;
  restartAt = 0; // the restart this countdown armed just spawned
  child = spawn({
    cmd: ['bun', 'src/server.ts'],
    stdout: 'inherit', stderr: 'inherit', stdin: 'inherit',
    // Dev default: record every game's demo into logs/demos/ - the
    // results ledger pairs with a full replay. Prod spawns without the
    // watcher, so this default can't leak there.
    env: Object.assign({}, process.env, { FPS_STATE_URL: STATE_URL, FPS_DEMO: process.env.FPS_DEMO ?? 'logs/demos' }),
  });
  // Crash or /dev/shutdown outside a restart(): dev means "server is up",
  // so a dead child respawns. restart() itself serializes its own boot.
  // A child that dies in <3s never bound (EADDRINUSE) — two in a row means
  // the port is squatted, not a crash: name the squatter and ask, don't
  // spin a respawn loop spewing the same bind error forever.
  void child.exited.then(() => {
    if (restarting || child!.exitCode === null) {return;}
    if (Date.now() - bootAt < 3000) {
      bindFails += 1;
      if (bindFails >= 2) { void portConflict(); return; } // don't respawn — wait for portConflict to resolve
    } else {bindFails = 0;}
    say('[dev-watch] server exited — respawning');
    boot();
    return undefined;
  });
}

/** Who owns :PORT? netstat gives the LISTENING pid, tasklist the name. */
function portOwner(): { pid: number; name: string } | null {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[3] === 'LISTENING' && (parts[1]!.endsWith(`:${PORT}`))) {
        const pid = Number(parts[4]);
        if (!pid) {return null;}
        try {
          const tl = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
          const name = tl.split('"')[1] ?? `pid ${pid}`;
          return { pid, name };
        } catch { return { pid, name: `pid ${pid}` }; }
      }
    }
  } catch { /* netstat missing — report nothing rather than guess */ }
  return null;
}

function ask(q: string): Promise<string> {
  process.stdout.write(q);
  return new Promise((res) => {
    const onData = (d: Buffer) => { process.stdin.off('data', onData); res(d.toString().trim().toLowerCase()); };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function portConflict(): Promise<void> {
  if (conflictBusy) {return;}
  conflictBusy = true;
  try {
    const owner = portOwner();
    if (!owner) {
      say(`[dev-watch] :${PORT} busy but no LISTENING owner — waiting 2s for release...`);
      await new Promise((r) => setTimeout(r, 2000));
      const owner2 = portOwner();
      if (!owner2) {
        say(`[dev-watch] :${PORT} still busy (TIME_WAIT?) — save a file or rerun to retry`);
        bindFails = 0;
        return;
      }
      // fall through to kill logic below with owner2
      say(`[dev-watch] :${PORT} is held by ${owner2.name} (pid ${owner2.pid}) — the server can't bind.`);
      const a = await ask(`[dev-watch] kill ${owner2.name}? [y/N] `);
      if (a === 'y') {
        try {
          execFileSync('taskkill', ['/F', '/PID', String(owner2.pid)]);
          say(`[dev-watch] ${owner2.name} killed — waiting for port release...`);
          await new Promise((r) => setTimeout(r, 2000));
          bindFails = 0;
          boot();
        } catch (error) {
          say(`[dev-watch] kill failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        bindFails = 0;
        say('[dev-watch] leaving it alone — save a file or rerun to retry');
      }
      return;
    }
    say(`[dev-watch] :${PORT} is held by ${owner.name} (pid ${owner.pid}) — the server can't bind.`);
    const a = await ask(`[dev-watch] kill ${owner.name}? [y/N] `);
    if (a === 'y') {
      try {
        execFileSync('taskkill', ['/F', '/PID', String(owner.pid)]);
        say(`[dev-watch] ${owner.name} killed — waiting for port release...`);
        await new Promise((r) => setTimeout(r, 2000));
        bindFails = 0;
        boot();
      } catch (error) {
        say(`[dev-watch] kill failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      bindFails = 0;
      say('[dev-watch] leaving it alone — save a file or rerun to retry');
    }
  } finally {
    conflictBusy = false;
  }
}

// Graceful stop before the hard kill: on Windows kill() is TerminateProcess
// — no SIGTERM — so the child's close frames ('server restarting' → the
// client banner) never leave without this door. 1s drain budget, then kill.
async function drain(): Promise<void> {
  try {
    await Promise.race([
      fetch(`http://127.0.0.1:${PORT}/dev/shutdown?key=${process.env.FPS_ADMIN_TOKEN ?? 'devdemo'}`),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    if (child) {await Promise.race([child.exited, new Promise((r) => setTimeout(r, 800))]);}
  } catch { /* server not answering — kill() is the fallback anyway */ }
}

async function restart(): Promise<void> {
  if (restarting) { pending = true; return; }
  restarting = true;
  say('[dev-watch] restart — shared/ or src/ changed');
  await drain();
  if (child && child.exitCode === null) {child.kill();}
  await child?.exited;
  boot();
  restarting = false;
  if (pending) { pending = false; void restart(); }
}

for (const dir of DIRS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(dir, { recursive: true }, (_ev, file) => {
    if (!file || !file.endsWith('.ts')) {return;}
    if (timer) {clearTimeout(timer);}
    timer = setTimeout(() => void restart(), DEBOUNCE_MS);
    // Debounce + drain (~1.8s) until the sockets actually close.
    restartAt = Date.now() + DEBOUNCE_MS + 1800;
  });
}

boot();
say(`[dev-watch] watching ${DIRS.join(', ')} — editing shared/ restarts the server`);
