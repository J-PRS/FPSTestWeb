/**
 * reconnpos.ts — grace reconnect POSITION restore.
 *
 *   bun _tools/e2e/reconnpos.ts
 *
 * Same drop/reclaim dance as reconnect.ts, but asserts the LOCAL player
 * lands back where they were — not at the spawn ring.
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { check, checkCount } from './check.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=e2ereconnpos&bots=0'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  await client.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await sleep(1000); // let the first position reports land server-side

  const p0 = await client.test<{ x: number; y: number; z: number }>(`({ x: t.player.pos.x, y: t.player.pos.y, z: t.player.pos.z })`);
  console.log(`  spawn pos: ${JSON.stringify(p0)}`);

  // Declared teleport ~25m off — the judge needs markTeleport or the jump
  // reads as divergence and a correction would pollute the measurement.
  await client.test(`(() => {
    t.player.pos.set(t.player.pos.x + 25, t.player.pos.y + 1, t.player.pos.z + 25);
    t.player.markTeleport();
    return true;
  })()`);
  await sleep(800); // reports stream at 20Hz — plenty of landing time

  const p1 = await client.test<{ x: number; y: number; z: number }>(`({ x: t.player.pos.x, y: t.player.pos.y, z: t.player.pos.z })`);
  console.log(`  moved pos: ${JSON.stringify(p1)}`);
  check(Math.hypot(p1.x - p0.x, p1.z - p0.z) > 10, `teleport landed (${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(1)}m from spawn)`);

  await client.test(`t.networkManager.disconnect()`);
  await sleep(1500);

  const wsUrl = `ws://localhost:${stack.serverPort}/ws`;
  await client.page.evaluate(`window.__test.networkManager.connect('${wsUrl}')`);
  await client.waitFor(`t.networkManager.isConnected()`, 20000);
  await sleep(1500); // gameState → restoreLocalPlayer

  const id2 = await client.test<string>(`t.networkManager.localPlayerId`);
  const p2 = await client.test<{ x: number; y: number; z: number }>(`({ x: t.player.pos.x, y: t.player.pos.y, z: t.player.pos.z })`);
  console.log(`  post-reconnect pos: ${JSON.stringify(p2)} (id ${id2})`);

  const drift = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  check(drift < 10, `position restored near drop point (${drift.toFixed(1)}m drift)`);

  console.log(stack.serverLog().split('\n').filter((l) => /reconnect|reclaim|connected|spawn/i.test(l)).slice(-12).join('\n'));
} finally {
  await closeClient(client);
  stack.down();
}
console.log(`\n${checkCount()} checks passed`);
