/**
 * prodboot.ts — measure PRODUCTION open time: serve dist/ via vite
 * preview, real game server, headed Chrome. Reports the load:* marks
 * waterfall + nav→connected wall time.
 *
 *   E2E_HEADED=1 bun _tools/e2e/prodboot.ts [--room x] [--bots 8] [--map lagoon]
 */
import { spawn } from 'bun';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const arg = (n: string, d: string): string =>
  process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1]! : d;
const BOTS = arg('bots', '8');
const MAP = arg('map', 'lagoon');
const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url: string, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* booting */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${url}`);
    await sleep(200);
  }
}

// preview server on 5500+ (vite preview serves dist/)
const prevPort = 5500;
const prev = spawn([
  process.platform === 'win32' ? 'npx.cmd' : 'npx', 'vite', 'preview',
  '--port', String(prevPort), '--strictPort',
], { cwd: `${REPO}client`, stdout: 'ignore', stderr: 'ignore' });
await waitHttp(`http://localhost:${prevPort}/`);

const stack = await upStack({ clientPort: prevPort });
try {
  const tNav = Date.now();
  // ?debug — prod builds only wire window.__test with it (dev hosts only).
  const client = await launchClient(stack.clientUrl(`&room=prodboot&map=${MAP}&bots=${BOTS}&mode=ctf&net=ws&debug`));
  try {
    await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
    const tConn = Date.now() - tNav;
    console.log(`nav→connected: ${tConn}ms wall (incl. vite preview + browser launch)`);
    const marks = await client.test<[string, number][]>(
      `performance.getEntriesByType('mark').filter(m => m.name.startsWith('load:')).map(m => [m.name.slice(5), Math.round(m.startTime)])`);
    let prev2 = 0;
    for (const [name, t] of marks) { console.log(`  ${name}: +${t - prev2}ms (total ${t}ms)`); prev2 = t; }
    const remotes = await client.test<number>(`t.world.remotePlayers.entities.size`);
    console.log(`remotes: ${remotes}`);
  } finally {
    await closeClient(client);
  }
} finally {
  stack.down();
  prev.kill();
}
