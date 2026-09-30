/**
 * boomshot.ts — fire a real AOE blast + projectile through the wire, then
 * screenshot mid-blast so bloom/emitter HDR can be eyeballed.
 *   bun _tools/e2e/boomshot.ts [pitch] [yaw] [extra]
 * Writes _tools/e2e/shots/boom.png
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const pitch = Number(process.argv[2] ?? -0.25);
const yaw = Number(process.argv[3] ?? 0.6);
const extra = process.argv[4] ?? '';
const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=boomshot&bots=0${extra}`));
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await client.page.evaluate(`(() => {
    const p = window.__test.player;
    p.pitch = ${pitch}; p.yaw = ${yaw};
  })()`);
  await new Promise(r => setTimeout(r, 1500));

  // Blast point: ~14m ahead of the camera on the ground, so the whole
  // explosion (flash + shock domes + sparks) sits in frame.
  const hit = await client.page.evaluate(`(() => {
    const t = window.__test;
    const p = t.player.pos.clone();
    const dir = { x: -Math.sin(${yaw}), z: -Math.cos(${yaw}) };
    const bx = p.x + dir.x * 14, bz = p.z + dir.z * 14;
    const by = t.terrain ? t.terrain.heightAt ? t.terrain.heightAt(bx, bz) : p.y - 2 : p.y - 2;
    const pos = { x: bx, y: (by ?? p.y - 2) + 0.5, z: bz };
    t.networkManager.send({ type: 'aoeShot', position: pos, weaponType: 4,
      excludeTargetId: null, directHit: false });
    // Rocket projectile for a trail — fired forward, tracked by server.
    t.networkManager.send({ type: 'shot', targetId: null, weaponType: 0,
      position: { x: p.x, y: p.y, z: p.z },
      velocity: { x: dir.x * 60, y: 2, z: dir.z * 60 },
      projectileId: 'e2e-trail' });
    return pos;
  })()`);
  console.log('blast at', JSON.stringify(hit));

  // SwiftShader ~7x slow: wall-clock waits map to ~1/7th game time.
  for (const [ms, name] of [[900, 'boom_a'], [1200, 'boom_b'], [1500, 'boom_c']] as const) {
    await new Promise(r => setTimeout(r, ms));
    mkdirSync(OUT, { recursive: true });
    const file = join(OUT, `${name}.png`);
    await client.page.screenshot({ path: file });
    console.log('wrote', file);
  }
} finally {
  await closeClient(client);
  stack.down();
}
