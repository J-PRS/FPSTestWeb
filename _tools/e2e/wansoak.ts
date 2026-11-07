/**
 * wansoak.ts — ghostsoak against a real WAN server (play.jprice.app).
 *
 *   E2E_GPU=1 bun _tools/e2e/wansoak.ts [--secs 120] [--room headhunt-1]
 *     [--server https://play.jprice.app] [--client http://127.0.0.1:5500]
 *
 * Points a local prod-build client (vite preview :5500) at the real
 * server via ?server= — the same ghost metrics ghostsoak reads, but
 * under real WAN latency instead of a spawned localhost stack.
 * Server log scraping is skipped (no remote serverLog); ghost stats
 * come from window.__trailDump like ghostsoak.
 */
import { launchClient, closeClient } from './browser.ts';

const arg = (name: string, dflt: string): string =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : dflt;
const SECS = Number(arg('secs', '120'));
const SERVER = arg('server', 'https://play.jprice.app');
const ROOM = arg('room', 'headhunt-1');
const CLIENT = arg('client', 'http://127.0.0.1:5500');
const NET = arg('net', 'ws');

const client = await launchClient(
  `${CLIENT}/?debug&server=${encodeURIComponent(SERVER)}&room=${encodeURIComponent(ROOM)}&net=${NET}`);
try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 1`, 45000);
  const remotes = await client.test<number>(`t.world.remotePlayers.entities.size`);
  const tier = await client.test<string>(`t.networkManager.getTransportTier() ?? 'unknown'`);
  console.log(`WAN room populated (${remotes} remotes, ${tier}) — soaking ${SECS}s wall`);

  await new Promise((r) => setTimeout(r, SECS * 1000));

  const diag = await client.test<Record<string, unknown>>(`window.__trailDump ? window.__trailDump() : null`);
  console.log('\n=== ghosts (WYSIWYG) — WAN ===');
  console.log(JSON.stringify(diag?.['ghosts'] ?? { none: 'no samples' }, null, 1));
} finally {
  await closeClient(client);
}
