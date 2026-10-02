/**
 * trailprobe6.ts — project a live ribbon slot's verts to NDC and count
 * the draw call: is the strip on-screen while invisible?
 *   bun _tools/e2e/trailprobe6.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=trailprobe6&bots=0&net=ws'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await sleep(1500);

  const info = await client.page.evaluate(`(async () => {
    const t = window.__test;
    const { weaponDef } = await import('/src/weapons.ts');
    const p = t.player;
    const V = p.pos.constructor;
    // Fire along +X, then instantly step the CAMERA... actually just look
    // along -Z is fine; the bolt streaks right past at eye level.
    const dir = new V(0, 0.15, -1).normalize();
    p.onWeaponFire(weaponDef(0), {
      origin: p.pos.clone().add(new V(0, 1.4, 0)),
      dir, playerVel: new V(0, 0, 0) });
    // Opaque red — if a fat streak still doesn't show, it isn't drawing.
    t.scene.traverse(o => {
      if (o.userData?.dbg?.kind !== 'trailBatch') return;
      const M = o.material.constructor;
      o.material = new M({ color: 0xff0044 });
      o.material.vertexColors = false;
      o.material.needsUpdate = true;
    });
    // Park 40m off the flight line and track the bolt — perpendicular
    // view so the ribbon can't foreshorten into a dot.
    for (let f = 0; f < 40; f++) {
      const q = t.world.projectiles.find(x => !x.exploded && !x.dead);
      if (!q) break;
      p.pos.set(q.pos.x + 40, q.pos.y, q.pos.z);
      const d = q.pos.clone().sub(p.pos);
      p.yaw = Math.atan2(-d.x, -d.z);
      p.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      await new Promise(r => setTimeout(r, 16));
    }

    const cam = p.camera ?? t.player.camera;
    cam.updateMatrixWorld();
    const proj = t.world.projectiles.find(x => !x.exploded && !x.dead);
    const out = { proj: null, ndc: [], drawCalls: null };
    if (proj) {
      out.proj = { age: +proj.age.toFixed(2), pos: [proj.pos.x|0, proj.pos.y|0, proj.pos.z|0],
        vel: +proj.vel.length().toFixed(0),
        ribs: (proj.ribbons ?? []).map(r => ({ slot: r.slot, count: r.count, stopped: r.stopped })) };
      t.scene.traverse(o => {
        if (o.userData?.dbg?.kind !== 'trailBatch') return;
        const b = o.userData.dbg.batch;
        const r0 = proj.ribbons?.[0];
        if (!r0 || r0.slot < 0) return;
        const base = r0.slot * 288;
        for (let i = Math.max(0, r0.count - 8); i < r0.count; i++) {
          const o2 = base + i * 6;
          const v = new V(b.pos[o2], b.pos[o2 + 1], b.pos[o2 + 2]);
          v.project(cam);
          out.ndc.push([+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(3)]);
        }
        out.camPos = [cam.position.x|0, cam.position.y|0, cam.position.z|0];
        out.vertWorld = [b.pos[base + (r0.count-1)*6], b.pos[base + (r0.count-1)*6+1], b.pos[base + (r0.count-1)*6+2]].map(x=>+x.toFixed(1));
      });
    }
    // Draw-call A/B: hide the batch for one frame, compare call counts.
    let mesh = null;
    t.scene.traverse(o => { if (o.userData?.dbg?.kind === 'trailBatch') mesh = o; });
    if (mesh) {
      const r = t.rendererSetup?.renderer;
      await new Promise(rr => requestAnimationFrame(rr));
      const on = r.info.render.calls;
      mesh.visible = false;
      await new Promise(rr => requestAnimationFrame(rr));
      const off = r.info.render.calls;
      mesh.visible = true;
      out.drawCalls = { on, off };
    }
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await client.page.screenshot({ path: join(OUT, 'trailprobe6.png') });
  console.log('wrote shots/trailprobe6.png');
} finally {
  await closeClient(client);
  stack.down();
}
