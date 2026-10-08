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
const DEBOUNCE_MS = 150;

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
try {
  Bun.serve({
    port: STATE_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/state') return new Response('not found', { status: 404 });
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
  console.log(`[dev-watch] seat handoff on :${STATE_PORT} (in-memory)`);
} catch {
  console.log(`[dev-watch] seat handoff unavailable — :${STATE_PORT} busy, restarts re-spawn at base`);
}

let bootAt = 0;
let bindFails = 0;
let conflictBusy = false;

function boot(): void {
  bootAt = Date.now();
  child = spawn({
    cmd: ['bun', 'src/server.ts'],
    stdout: 'inherit', stderr: 'inherit', stdin: 'inherit',
    env: { ...process.env, FPS_STATE_URL: STATE_URL },
  });
  // Crash or /dev/shutdown outside a restart(): dev means "server is up",
  // so a dead child respawns. restart() itself serializes its own boot.
  // A child that dies in <3s never bound (EADDRINUSE) — two in a row means
  // the port is squatted, not a crash: name the squatter and ask, don't
  // spin a respawn loop spewing the same bind error forever.
  void child.exited.then(() => {
    if (restarting || child!.exitCode === null) return;
    if (Date.now() - bootAt < 3000) {
      bindFails++;
      if (bindFails >= 2) { void portConflict(); return; }
    } else bindFails = 0;
    console.log('[dev-watch] server exited — respawning');
    boot();
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
        if (!pid) return null;
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
  if (conflictBusy) return;
  conflictBusy = true;
  try {
    const owner = portOwner();
    if (!owner) {
      console.log(`[dev-watch] :${PORT} busy but no LISTENING owner found — is something else on it?`);
      bindFails = 0;
      return;
    }
    console.log(`[dev-watch] :${PORT} is held by ${owner.name} (pid ${owner.pid}) — the server can't bind.`);
    const a = await ask(`[dev-watch] kill ${owner.name}? [y/N] `);
    if (a === 'y') {
      try {
        execFileSync('taskkill', ['/F', '/PID', String(owner.pid)]);
        console.log(`[dev-watch] ${owner.name} killed — booting`);
        bindFails = 0;
        boot();
      } catch (e) {
        console.log(`[dev-watch] kill failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      bindFails = 0;
      console.log('[dev-watch] leaving it alone — save a file or rerun to retry');
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
      fetch(`http://127.0.0.1:${PORT}/dev/shutdown`),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    if (child) await Promise.race([child.exited, new Promise((r) => setTimeout(r, 800))]);
  } catch { /* server not answering — kill() is the fallback anyway */ }
}

async function restart(): Promise<void> {
  if (restarting) { pending = true; return; }
  restarting = true;
  console.log('[dev-watch] restart — shared/ or src/ changed');
  await drain();
  if (child && child.exitCode === null) child.kill();
  await child?.exited;
  boot();
  restarting = false;
  if (pending) { pending = false; void restart(); }
}

for (const dir of DIRS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(dir, { recursive: true }, (_ev, file) => {
    if (!file || !file.endsWith('.ts')) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void restart(), DEBOUNCE_MS);
  });
}

boot();
console.log(`[dev-watch] watching ${DIRS.join(', ')} — editing shared/ restarts the server`);
