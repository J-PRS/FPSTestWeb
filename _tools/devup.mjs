#!/usr/bin/env node
// _tools/devup.mjs - cross-platform clean dev stack.
//
// Reaps stale FPSWebTest dev processes, frees :5400/:8000, launches the
// game server + client, waits for readiness, streams prefixed output to
// one terminal, and tears everything down on Ctrl+C.
//
// Usage: node _tools/devup.mjs [--no-reap] [--no-logs]
//        (devup.bat at repo root delegates here)
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { waitForUrl } from './wait-for.mjs';

const ROOT = process.cwd();
const isWin = process.platform === 'win32';
const BUN_BIN = isWin ? `${process.env.USERPROFILE}\\.bun\\bin` : `${process.env.HOME}/.bun/bin`;

const args = process.argv.slice(2);
const NO_REAP = args.includes('--no-reap');
const NO_LOGS = args.includes('--no-logs');

const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function pidsOnPort(port) {
  const pids = new Set();
  if (isWin) {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    for (const line of (r.stdout || '').split(/\\r?\\n/)) {
      const m = line.trim().match(/^TCP\\s+\\S+:(\\d+)\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$/i);
      if (m && Number(m[1]) === port) pids.add(Number(m[2]));
    }
  } else {
    const r = spawnSync('sh', ['-c', `lsof -ti:${port} 2>/dev/null`], { encoding: 'utf8' });
    for (const t of (r.stdout || '').split(/\\s+/)) if (t && /^\\d+$/.test(t)) pids.add(Number(t));
  }
  return [...pids];
}

function freePort(port) {
  for (const pid of pidsOnPort(port)) {
    console.log(`${DIM}[devup] killing pid ${pid} on :${port}${RESET}`);
    if (isWin) spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    else { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}

function killTree(child) {
  if (!child || child.killed) return;
  if (isWin) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch {} }
  }
}

function prefixStream(stream, tag, color, log) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      process.stdout.write(`${color}[${tag}]${RESET} ${line}\n`);
      if (log) log.write(line + '\n');
    }
  });
  stream.on('end', () => {
    if (buf) {
      process.stdout.write(`${color}[${tag}]${RESET} ${buf}\n`);
      if (log) log.write(buf + '\n');
    }
  });
}

// 1. reap
if (!NO_REAP) {
  console.log(`${DIM}[devup] reaping stale dev processes (>6h)...${RESET}`);
  spawnSync('node', ['_tools/reap.mjs', '--kill'], { stdio: 'inherit', cwd: ROOT });
}

// 2. free canonical ports
console.log(`${DIM}[devup] freeing :5400 and :8000 ...${RESET}`);
freePort(5400);
freePort(8000);

// 3. logs
let logServer = null, logClient = null;
if (!NO_LOGS) {
  const logDir = join(ROOT, 'logs');
  try { mkdirSync(logDir, { recursive: true }); } catch {}
  logServer = createWriteStream(join(logDir, 'server.log'), { flags: 'a' });
  logClient = createWriteStream(join(logDir, 'client.log'), { flags: 'a' });
}

const env = { ...process.env };
if (isWin) env.PATH = `${BUN_BIN};${env.PATH || ''}`;
else env.PATH = `${BUN_BIN}:${env.PATH || ''}`;

// 4. spawn
console.log(`${DIM}[devup] starting game server on :8000 ...${RESET}`);
const server = spawn('bun run dev', {
  shell: true, cwd: join(ROOT, 'server_bun'), env,
  stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin,
});
console.log(`${DIM}[devup] starting client on :5400 ...${RESET}`);
const client = spawn('npm run dev', {
  shell: true, cwd: join(ROOT, 'client'), env,
  stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin,
});

prefixStream(server.stdout, 'server', BLUE, logServer);
prefixStream(server.stderr, 'server', BLUE, logServer);
prefixStream(client.stdout, 'client', GREEN, logClient);
prefixStream(client.stderr, 'client', GREEN, logClient);

// 5. teardown
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${DIM}[devup] shutting down...${RESET}`);
  killTree(server);
  killTree(client);
  if (logServer) logServer.end();
  if (logClient) logClient.end();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

server.on('exit', (code, sig) => {
  if (shuttingDown) return;
  console.error(`${RED}[devup] server exited (${code ?? sig})${RESET}`);
  shutdown(code ?? 1);
});
client.on('exit', (code, sig) => {
  if (shuttingDown) return;
  console.error(`${RED}[devup] client exited (${code ?? sig})${RESET}`);
  shutdown(code ?? 1);
});

// 6. readiness
(async () => {
  console.log(`${DIM}[devup] waiting for server /health ...${RESET}`);
  const serverReady = await waitForUrl('http://127.0.0.1:8000/health', { timeoutMs: 60000, intervalMs: 500 });
  if (!serverReady) { console.error(`${RED}[devup] server did not become ready in 60s${RESET}`); shutdown(1); return; }
  console.log(`${DIM}[devup] server ready. waiting for client ...${RESET}`);
  const clientReady = await waitForUrl('http://127.0.0.1:5400/', { timeoutMs: 60000, intervalMs: 500 });
  if (!clientReady) { console.error(`${RED}[devup] client did not become ready in 60s${RESET}`); shutdown(1); return; }
  console.log(`${GREEN}[devup] READY -> http://localhost:5400  (server :8000)${RESET}  Ctrl+C to stop.`);
  if (!NO_LOGS) console.log(`${DIM}[devup] logs: logs/server.log, logs/client.log${RESET}`);
})();