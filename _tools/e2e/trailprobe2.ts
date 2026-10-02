/**
 * trailprobe2.ts — bisect "lit ribbon slots but nothing on screen".
 * Fires shots, then swaps the ribbon batch material for opaque red:
 * red streaks appear -> blend/color path at fault; still nothing ->
 * geometry/index/draw-call level. Writes shots/trailprobe2*.png
 *   bun _tools/e2e/trailprobe2.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=trailprobe2&bots=0&net=ws'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await sleep(2000);

  const fireResult = await client.page.evaluate(`(async () => {
    try {
      const t = window.__test;
      const { weaponDef } = await import('/src/weapons.ts');
      const p = t.player;
      const dir = new p.pos.constructor(0.35, 0.9, 0).normalize();
      for (let i = 0; i < 3; i++) {
        p.onWeaponFire(weaponDef(0), {
          origin: p.pos.clone().add(new p.pos.constructor(0, 1.4, 0)),
          dir: dir.clone(),
          playerVel: p.vel.clone(),
        });
        await new Promise(r => setTimeout(r, 300));
      }
      p.yaw = Math.atan2(0.35, 0); p.pitch = 0.6;
      return { ok: true };
    } catch (err) { return { ok: false, err: String(err && err.stack || err) }; }
  })()`);
  console.log('fire:', JSON.stringify(fireResult));
  await sleep(800);

  const info = await client.page.evaluate(`(() => {
    const t = window.__test;
    const meshes = [];
    t.scene.traverse(o => { if (o.userData?.dbg?.kind === 'trailBatch') meshes.push(o); });
    return meshes.map(m => ({
      visible: m.visible, inScene: !!m.parent, layers: m.layers.mask,
      drawRange: m.geometry.drawRange, idxCount: m.geometry.index?.count,
      mat: { transparent: m.material.transparent, blending: m.material.blending,
             vc: m.material.vertexColors, opacity: m.material.opacity,
             visible: m.material.visible, side: m.material.side },
      camLayers: t.camera ? t.camera.layers.mask : null,
      // Lit vertex sanity: how many position floats are nonzero?
      nz: (() => { const a = m.geometry.attributes.position.array;
        let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== 0) n++;
        return n; })(),
    }));
  })()`);
  console.log('batch meshes:', JSON.stringify(info, null, 1));

  await client.page.screenshot({ path: join(OUT, 'trailprobe2-before.png') });

  // Opaque red swap — kills blend/color/alpha as suspects.
  const swap = await client.page.evaluate(`(() => {
    const t = window.__test;
    let n = 0;
    t.scene.traverse(o => {
      if (o.userData?.dbg?.kind !== 'trailBatch') return;
      const M = o.material.constructor;
      o.material = new M({ color: 0xff0044 });
      o.material.vertexColors = false;
      o.material.needsUpdate = true;
      n++;
    });
    return n;
  })()`);
  console.log('materials swapped:', swap);
  await sleep(300);
  await client.page.screenshot({ path: join(OUT, 'trailprobe2-red.png') });
  console.log('wrote shots');
} finally {
  await closeClient(client);
  stack.down();
}
