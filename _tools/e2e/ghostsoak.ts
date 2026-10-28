/**
 * ghostsoak.ts — WYSIWYG soak: rendered-body vs lag-comp ghost divergence.
 *
 *   E2E_GPU=1 bun _tools/e2e/ghostsoak.ts [--secs 120] [--bots 12] [--map lagoon]
 *
 * One headless client joins a bot-populated CTF room on a REAL server.
 * ghostTrace samples remote bodies every 100ms while it plays:
 *   rw rendered↔wire — the interpolation lag you see
 *   wg wire↔ghost    — lag-comp projection distance
 *   rg rendered↔ghost — what you see vs what the server judges; the
 *        hit-feel number. rg>>0 = aiming at a body the server never tests.
 * Dumps p50/p95/max + the worst offenders + the server's ghost-hit lines.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const arg = (name: string, dflt: string): string =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : dflt;
const SECS = Number(arg('secs', '120'));
const BOTS = arg('bots', '12');
const MAP = arg('map', 'lagoon');
const NET = arg('net', 'ws');

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=ghostsoak&map=${MAP}&bots=${BOTS}&mode=ctf&net=${NET}`));

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 1`, 30000);
  const remotes = await client.test<number>(`t.world.remotePlayers.entities.size`);
  const tier = await client.test<string>(`t.networkManager.getTransportTier() ?? 'unknown'`);
  console.log(`room populated (${remotes} remotes, ${tier}) — soaking ${SECS}s wall`);
  if (NET === 'wt' && !tier.startsWith('wt')) {throw new Error(`WT requested but connected via ${tier}`);}

  await new Promise((r) => setTimeout(r, SECS * 1000));

  const diag = await client.test<Record<string, unknown>>(`window.__trailDump ? window.__trailDump() : null`);
  console.log('\n=== ghosts (WYSIWYG) ===');
  console.log(JSON.stringify(diag?.['ghosts'] ?? { none: 'no samples' }, null, 1));

  const log = stack.serverLog();
  const ghostHits = log.split('\n').filter((l) => l.includes('ghost hit'));
  console.log(`\n=== server ghost-hit lines: ${ghostHits.length} ===`);
  for (const l of ghostHits.slice(-15)) console.log(`  ${l.slice(0, 240)}`);
} finally {
  await closeClient(client);
  stack.down();
}
