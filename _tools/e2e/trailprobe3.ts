/**
 * trailprobe3.ts — red-dot follow-up: dump a live ribbon slot's vertex
 * pairs (are both verts of a sample identical?) plus the RibbonTrail's
 * stored side vectors and fades that produced them.
 *   bun _tools/e2e/trailprobe3.ts
 */
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const stack = await upStack();
const client = await launchClient(stack.clientUrl('&room=trailprobe3&bots=0&net=ws'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await sleep(2000);
  await client.page.evaluate(`(async () => {
    const t = window.__test;
    const { weaponDef } = await import('/src/weapons.ts');
    const p = t.player;
    const dir = new p.pos.constructor(0.35, 0.9, 0).normalize();
    for (let i = 0; i < 2; i++) {
      p.onWeaponFire(weaponDef(0), {
        origin: p.pos.clone().add(new p.pos.constructor(0, 1.4, 0)),
        dir: dir.clone(), playerVel: p.vel.clone() });
      await new Promise(r => setTimeout(r, 250));
    }
    p.yaw = Math.atan2(0.35, 0); p.pitch = 0.6;
  })()`);
  await sleep(400);

  const dump = await client.page.evaluate(`(() => {
    const t = window.__test;
    const out = { projs: [], slots: [] };
    for (const p of t.world.projectiles) {
      out.projs.push({
        pos: [p.pos.x | 0, p.pos.y | 0, p.pos.z | 0],
        ribbons: (p.ribbons ?? []).map(r => ({
          slot: r.slot, count: r.count, pushed: r.pushed,
          life: r.life, width: r.width, bb: r.billboard, stopped: r.stopped,
          time: +r.time.toFixed(2),
          head: r.head,
          // Stored ring data for the newest sample
          newest: r.head >= 0 ? {
            p: [r.px[r.head].toFixed(1), r.py[r.head].toFixed(1), r.pz[r.head].toFixed(1)],
            s: [r.sx[r.head].toFixed(3), r.sy[r.head].toFixed(3), r.sz[r.head].toFixed(3)],
            d: [r.dx[r.head].toFixed(3), r.dy[r.head].toFixed(3), r.dz[r.head].toFixed(3)],
            st: +r.st[r.head].toFixed(2),
          } : null,
        })),
      });
    }
    t.scene.traverse(o => {
      if (o.userData?.dbg?.kind !== 'trailBatch') return;
      const b = o.userData.dbg.batch;
      for (const s of b.used) {
        const base = s * 96 * 3; // VERTS*3
        const pos = b.pos, col = b.col;
        const rows = [];
        for (let i = 0; i < 6; i++) {
          const o2 = base + i * 6;
          rows.push({
            a: [pos[o2].toFixed(1), pos[o2+1].toFixed(1), pos[o2+2].toFixed(1)],
            b: [pos[o2+3].toFixed(1), pos[o2+4].toFixed(1), pos[o2+5].toFixed(1)],
            c: [col[o2].toFixed(2), col[o2+1].toFixed(2), col[o2+2].toFixed(2)],
          });
        }
        out.slots.push({ slot: s, rows });
      }
    });
    return out;
  })()`);
  console.log(JSON.stringify(dump, null, 1));
} finally {
  await closeClient(client);
  stack.down();
}
