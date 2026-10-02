/**
 * trailprobe5.ts — side-on view test: fire along +X, teleport the player
 * perpendicular to the flight line, and screenshot so a ribbon can't
 * hide as an end-on speck. Also dumps renderer.info + NDC projection of
 * the live slot's head verts.
 *   bun _tools/e2e/trailprobe5.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=trailprobe5&bots=0&net=ws'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await sleep(1500);
  await client.page.evaluate(`(async () => {
    const t = window.__test;
    const { weaponDef } = await import('/src/weapons.ts');
    const p = t.player;
    // Sidestep first so the flight line is lateral to the camera.
    const V = p.pos.constructor;
    const spawn = p.pos.clone();
    window.__spawn = spawn;
    const dir = new V(1, 0.35, 0).normalize();
    p.onWeaponFire(weaponDef(0), {
      origin: spawn.clone().add(new V(0, 1.4, 0)),
      dir, playerVel: new V(0,0,0) });
    // Move 30m to the side (+Z) and look at a point ~35m along +X.
    p.pos.set(spawn.x, spawn.y, spawn.z + 30);
    const tgt = new V(spawn.x + 35, spawn.y + 14, spawn.z);
    const d = tgt.clone().sub(p.pos);
    p.yaw = Math.atan2(-d.x, -d.z) + Math.PI; // engine yaw convention varies; screenshot reveals truth
    p.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  })()`);
  // Let a few frames render the trail, then dump + shoot.
  await sleep(250);
  const info = await client.page.evaluate(`(() => {
    const t = window.__test;
    const r = t.renderer;
    const proj = t.world.projectiles.find(p => !p.exploded);
    let slotData = null;
    t.scene.traverse(o => {
      if (o.userData?.dbg?.kind !== 'trailBatch' || !proj) return;
      const b = o.userData.dbg.batch;
      for (const rb of proj.ribbons ?? []) {
        if (rb.slot < 0) continue;
        const base = rb.slot * 96 * 3;
        slotData = (slotData ?? []).concat([{
          slot: rb.slot, count: rb.count,
          v0: [b.pos[base], b.pos[base+1], b.pos[base+2]].map(x=>+x.toFixed(1)),
          v1: [b.pos[base+3], b.pos[base+4], b.pos[base+5]].map(x=>+x.toFixed(1)),
          c0: [b.col[base], b.col[base+1], b.col[base+2]].map(x=>+x.toFixed(2)),
        }]);
      }
    });
    return {
      projPos: proj && [proj.pos.x|0, proj.pos.y|0, proj.pos.z|0],
      projAge: proj && +proj.age.toFixed(2),
      playerPos: [t.player.pos.x|0, t.player.pos.y|0, t.player.pos.z|0],
      yaw: t.player.yaw, pitch: t.player.pitch,
      render: r && { calls: r.info.render.calls, tris: r.info.render.triangles },
      slotData,
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await client.page.screenshot({ path: join(OUT, 'trailprobe5.png') });
  console.log('wrote shots/trailprobe5.png');
} finally {
  await closeClient(client);
  stack.down();
}
