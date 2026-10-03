/**
 * trailprobe4.ts — stack-trace the stop() call that kills live
 * projectile ribbons after exactly one sample.
 *   bun _tools/e2e/trailprobe4.ts
 */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=trailprobe4&bots=0&net=ws'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  // Instrument BEFORE firing so the first shot's stop is caught too.
  await client.page.evaluate(`(async () => {
    const mod = await import('/src/effects/RibbonTrail.ts');
    const R = mod.RibbonTrail;
    for (const k of ['stop']) {
      const orig = R.prototype[k];
      R.prototype[k] = function () {
        this.__stopStack = new Error('stop').stack;
        return orig.apply(this, arguments);
      };
    }
    window.__stopStacks = [];
    const origDispose = R.prototype.dispose;
    R.prototype.dispose = function () {
      if (this.__stopStack) window.__stopStacks.push(this.__stopStack);
      return origDispose.apply(this, arguments);
    };
  })()`);
  await sleep(1000);
  await client.page.evaluate(`(async () => {
    const t = window.__test;
    const { weaponDef } = await import('/src/weapons.ts');
    const p = t.player;
    const dir = new p.pos.constructor(0.35, 0.9, 0).normalize();
    for (let i = 0; i < 3; i++) {
      p.onWeaponFire(weaponDef(0), {
        origin: p.pos.clone().add(new p.pos.constructor(0, 1.4, 0)),
        dir: dir.clone(), playerVel: p.vel.clone() });
      await new Promise(r => setTimeout(r, 300));
    }
  })()`);
  await sleep(600);
  const dump = await client.page.evaluate(`(() => {
    const t = window.__test;
    return {
      projs: t.world.projectiles.map(p => ({
        age: +p.age.toFixed(2), exploded: p.exploded, dead: p.dead,
        isRemote: p.isRemote, stuck: p.stuck,
        ribbons: (p.ribbons ?? []).map(r => ({
          slot: r.slot, count: r.count, stopped: r.stopped,
          stopStack: r.__stopStack ?? null })),
      })),
      disposedStacks: window.__stopStacks.slice(0, 4),
    };
  })()`);
  console.log(JSON.stringify(dump, null, 1));
} finally {
  await closeClient(client);
  stack.down();
}
