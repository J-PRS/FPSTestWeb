import { spawnSync, spawn } from 'node:child_process';
import { sleep } from 'bun';

const BUN = 'C:\\Users\\JPrice\\AppData\\Roaming\\npm\\node_modules\\.bin\\bun.exe'.replace(/\\/g, '/');
// resolve bun
const BUN2 = process.execPath.includes('bun') ? process.execPath : 'bun';

const args = process.argv.slice(2);
function arg(name: string, def = ''): string {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
}
const counts = arg('rooms', '2,10,16,24,32').split(',').map(Number);
const SECS = Number(arg('secs', '40'));
const SETTLE = Number(arg('settle', '30'));
const PORT = 8101;

const totalBots = counts.reduce((a, b) => a + b, 0);

// start server
const env = { ...process.env, FPS_PORT: String(PORT), FPS_NO_WT: '1', FPS_BOOT: 'mix', FPS_GLOBAL_MAX_PLAYERS: '4096' };
const srv = spawn(BUN2, ['src/server.ts'], { cwd: 'server_bun', env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverPid = srv.pid!;
console.log(`[mixtest] server pid=${serverPid} port=${PORT} rooms=${counts.join(',')} total=${totalBots}`);

// wait health
async function healthOk(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    return r.ok;
  } catch { return false; }
}
const t0 = Date.now();
while (!(await healthOk())) {
  if (srv.exitCode !== null) { console.error('server died'); process.exit(1); }
  if (Date.now() - t0 > 20000) { console.error('server never came up'); process.exit(1); }
  await sleep(500);
}
console.log('[mixtest] server up');

// spawn netBot per room
const botProcs: ReturnType<typeof spawn>[] = [];
counts.forEach((n, i) => {
  const room = `mix-${i + 1}`;
  const p = spawn(BUN2, ['tools/netBot.ts', '--bots', String(n), '--room', room, '--mode', 'dm', '--net', 'ws', '--url', `ws://localhost:${PORT}/ws`], {
    cwd: 'server_bun', stdio: ['ignore', 'pipe', 'pipe'],
  });
  botProcs.push(p);
  console.log(`[mixtest] room ${room}: ${n} bots (pid ${p.pid})`);
});

console.log(`[mixtest] settling ${SETTLE}s`);
await sleep(SETTLE * 1000);

// cpu sample start
function cpuOf(pid: number): number {
  const out = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).CPU`]).stdout.toString().trim();
  return Number.parseFloat(out) || 0;
}
const cpuA = cpuOf(serverPid);
const metrics = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
};
const m0 = await metrics();
console.log('[mixtest] players before measure:', (m0 as any)?.players);

console.log(`[mixtest] measuring ${SECS}s`);
await sleep(SECS * 1000);
const cpuB = cpuOf(serverPid);
const cpuPct = ((cpuB - cpuA) / SECS) * 100;
const m1 = await metrics();

// kill
for (const p of botProcs) { try { p.kill(); } catch {} }
try { srv.kill(); } catch {}

console.log('\n=== MIX RESULT ===');
console.log('rooms:', counts.join(', '));
console.log('total bots:', totalBots);
console.log('players:', (m1 as any)?.players);
console.log('cpuPct:', cpuPct.toFixed(1));
console.log('tickMs:', JSON.stringify((m1 as any)?.bandwidth?.phaseMs ? undefined : (m1 as any)?.tickMs));
console.log('memMB:', JSON.stringify((m1 as any)?.memory));
console.log('kbpsDownTotal:', (m1 as any)?.bandwidth?.kbpsDownTotal);
console.log('msgsIn:', (m1 as any)?.msgsIn);
console.log('eventLoopDelay p50:', (m1 as any)?.eventLoopDelayMs?.p50);

process.exit(0);