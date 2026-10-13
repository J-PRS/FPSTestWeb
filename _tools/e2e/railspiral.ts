/**
 * railspiral.ts — fire the railgun straight up and screenshot the Q2 coil
 * mid-flight. The coil is distance-phased (not time), so a vertical shot
 * keeps the whole helix on-screen under the ascending slug.
 *   bun _tools/e2e/railspiral.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&bots=0&net=ws'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await sleep(1500);

  await client.page.evaluate(`(async () => {
    const t = window.__test;
    const { weaponDef } = await import('/src/weapons.ts');
    const p = t.player;
    const V = p.pos.constructor;
    // Straight up — the coil hangs in the air while the slug climbs.
    const spawn = p.pos.clone().add(new V(0, 1.4, 0));
    p.onWeaponFire(weaponDef(7), {
      origin: spawn, dir: new V(0.12, 1, 0).normalize(),
      playerVel: new V(0, 0, 0) });
    // Sidestep off-axis: end-on, a helix foreshortens to a dot. Aim up
    // the flight line from ~18m out so the coil reads as a corkscrew.
    p.pos.set(spawn.x + 18, spawn.y + 8, spawn.z);
    const aim = spawn.clone().add(new V(0, 40, 0)).sub(p.pos);
    p.yaw = Math.atan2(-aim.x, -aim.z);
    p.pitch = Math.atan2(aim.y, Math.hypot(aim.x, aim.z));
  })()`);

  // The slug climbs for ~2s+; sample several points of the coil's life.
  for (let i = 0; i < 4; i++) {
    await sleep(350);
    await client.page.screenshot({ path: join(OUT, `railspiral${i}.png`) });
    console.log(`shot: railspiral${i}.png`);
  }
} finally {
  await closeClient(client);
  await stack.down();
}
