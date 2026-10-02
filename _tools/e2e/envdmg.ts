/**
 * envdmg.ts — does a client-sent environmentDamage claim over the RTC tier
 * get applied by the server? Repro for "bots shoot me, I take no damage".
 *
 *   bun _tools/e2e/envdmg.ts
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stack = await upStack();
const url = stack.clientUrl('&room=e2eenv&bots=0&net=rtc');
const c = await launchClient(url);

try {
  await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await c.waitFor(`t.networkManager.lastTickSeq >= 0`, 20000);
  const tier = await c.test<string>(`t.networkManager.transportTier ?? t.networkManager.ws?.tier`);
  console.log('tier:', tier);

  // Spawn protection is 2s — wait it out so protectedUntil can't mask this.
  await sleep(3000);
  const hp0 = await c.test<number>(`t.player.health`);
  console.log('hp before:', hp0);

  // Same call site the blast/pounce code uses.
  await c.test(`t.networkManager.sendEnvironmentDamage(25)`);
  await sleep(1500);
  const hp1 = await c.test<number>(`t.player.health`);
  console.log('hp after untagged 25:', hp1);

  await c.test(`t.networkManager.sendEnvironmentDamage(9, 'bot:E2E-1')`);
  await sleep(1500);
  const hp2 = await c.test<number>(`t.player.health`);
  console.log('hp after tagged 9:', hp2);

  console.log(hp1 < hp0 && hp2 < hp1 ? 'PASS envDamage applied over ' + tier : 'FAIL — claims sent, health unchanged');
} finally {
  await closeClient(c);
  console.log('--- server log tail ---');
  console.log(stack.serverLog().split('\n').filter((l) => /env|damage|hit|warn|error/i.test(l)).slice(-20).join('\n'));
  stack.down();
}
