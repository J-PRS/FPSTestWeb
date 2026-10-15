/**
 * trailgap.ts — measure the drawn gap between a live shell body and its
 * ribbon tip, per frame, plus a side-on screenshot mid-flight.
 *   bun _tools/debug/trailgap.ts
 * Fails (exit 1) if the mean tip gap exceeds the weld budget.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from '../e2e/browser.ts';
import { upStack } from '../e2e/env.ts';

const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=trailgap&bots=0&net=ws'));
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
    const dir = new V(0, 0.02, -1).normalize();
    p.onWeaponFire(weaponDef(0), {
      origin: p.pos.clone().add(new V(0, 1.4, 0)),
      dir, playerVel: new V(0, 0, 0) });
    const gaps = [];
    const rows = [];
    let spd = 0, frames = 0;
    for (let f = 0; f < 60; f++) {
      const q = t.world.projectiles.find(x => !x.exploded && !x.dead);
      if (!q) break;
      frames += 1;
      spd = q.vel.length();
      // Side-on tracking cam — the gap reads perpendicular, unforeshortened.
      p.pos.set(q.pos.x + 25, q.pos.y + 2, q.pos.z + 12);
      const d = q.pos.clone().sub(p.pos);
      p.yaw = Math.atan2(-d.x, -d.z);
      p.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      await new Promise(r => setTimeout(r, 16));
      // Body as drawn (instanced state object) vs ribbon tip verts.
      const body = q.mesh.position;
      let batch = null;
      t.scene.traverse(o => { if (o.userData?.dbg?.kind === 'trailBatch') batch = o.userData.dbg.batch; });
      const r0 = q.ribbons?.[0];
      if (batch && r0 && r0.slot >= 0 && r0.count >= 2) {
        const base = r0.slot * 288 + (r0.count - 1) * 6;
        const hx = batch.pos[base], hy = batch.pos[base + 1], hz = batch.pos[base + 2];
        // Unwritten verts sit at zeroed colors (release() zeroes the slot
        // and claim hands out zeroed memory) — undrawn, so no visual gap.
        const lit = batch.col[base] + batch.col[base + 1] + batch.col[base + 2];
        const g = lit > 0 ? Math.hypot(body.x - hx, body.y - hy, body.z - hz) : 0;
        gaps.push(g);
        rows.push({ age: +q.age.toFixed(2), count: r0.count, stopped: !!r0.stopped,
          follow: r0.follow ? [+r0.follow.x.toFixed(1), +r0.follow.y.toFixed(1), +r0.follow.z.toFixed(1)] : null,
          pxHead: r0.head >= 0 ? [+r0.px[r0.head].toFixed(1), +r0.py[r0.head].toFixed(1), +r0.pz[r0.head].toFixed(1)] : null,
          body: [+body.x.toFixed(1), +body.y.toFixed(1), +body.z.toFixed(1)],
          vert: [+hx.toFixed(1), +hy.toFixed(1), +hz.toFixed(1)], gap: +g.toFixed(2) });
      }
    }
    gaps.sort((a, b) => a - b);
    return { frames, spd: +spd.toFixed(1), n: gaps.length, rows,
      mean: gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2) : -1,
      p95: gaps.length ? +gaps[Math.floor(gaps.length * 0.95)].toFixed(2) : -1,
      max: gaps.length ? +gaps[gaps.length - 1].toFixed(2) : -1 };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await client.page.screenshot({ path: join(OUT, 'trailgap.png') });
  console.log('wrote shots/trailgap.png');
  // Weld budget: one frame of travel at bolt speed would read ~0.9m here —
  // the re-pin should hold the tip an order of magnitude under that.
  if (!(info.n >= 10 && info.mean >= 0 && info.mean < 0.6 && info.max < 1.2)) {
    console.log('TRAILGAP: FAIL');
    process.exit(1);
  }
  console.log('TRAILGAP: PASS');
} finally {
  await closeClient(client);
  await stack.down();
}
