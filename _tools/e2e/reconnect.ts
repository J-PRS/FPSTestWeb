/**
 * reconnect.ts — grace-period reconnect E2E.
 *
 *   bun _tools/e2e/reconnect.ts
 *
 * Real client joins, drops its socket mid-match, reconnects with the
 * persisted session token, and must land back on the SAME player seat —
 * same id, roster intact, tick stream resumed — not a fresh join.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { check, checkCount } from './check.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=e2ereconnect&bots=4'));

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await client.waitFor(`t.world.remotePlayers.entities.size >= 1`, 20000);
  const id1 = await client.test<string>(`t.networkManager.localPlayerId`);
  const roster1 = await client.test<number>(`t.world.remotePlayers.entities.size`);
  const seq1 = await client.test<number>(`t.networkManager.lastTickSeq`);

  // Hard drop — the server holds the seat open for the grace window.
  await client.test(`t.networkManager.disconnect()`);
  await new Promise((r) => setTimeout(r, 1500));

  // Reconnect on the same URL — the session token in localStorage does
  // the reclaim; a fresh seat would mint a new playerId.
  const wsUrl = `ws://localhost:${stack.serverPort}/ws`;
  await client.page.evaluate(`window.__test.networkManager.connect('${wsUrl}')`);
  await client.waitFor(`t.networkManager.isConnected()`, 20000);

  const id2 = await client.test<string>(`t.networkManager.localPlayerId`);
  check(id1 === id2, `seat reclaimed — same playerId (${id1} → ${id2})`);

  await client.waitFor(`t.world.remotePlayers.entities.size >= ${roster1}`, 20000);
  check(true, `roster rebuilt (${roster1} remotes)`);

  const seq0 = await client.test<number>(`t.networkManager.lastTickSeq`);
  await new Promise((r) => setTimeout(r, 2000));
  const seq2 = await client.test<number>(`t.networkManager.lastTickSeq`);
  check(seq2 > seq0, `tick stream resumed (${seq0} → ${seq2})`);

  // Server-side: the drop must NOT have produced a permanent leave —
  // leaves counts only grace-expired removals.
  const m = await stack.serverMetrics();
  check(m.leaves === 0, `no leaves counted (leaves=${m.leaves})`);

  console.log(`  info: pre-drop tick ${seq1}, post-rejoin tick ${seq2}`);
} finally {
  await closeClient(client);
  stack.down();
}
console.log(`\n${checkCount()} checks passed`);
