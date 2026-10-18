/**
 * watershot.ts — teleport over open water on a wet map, fire an AOE blast
 * at the waterline through the wire, screenshot mid-splash.
 *   bun _tools/e2e/watershot.ts [map]
 * Writes _tools/e2e/shots/water_*.png
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const map = process.argv[2] ?? 'lagoon';
const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=${map}&bots=0&net=ws`));
try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  await new Promise(r => setTimeout(r, 4000));

  const blast = await client.page.evaluate(`(() => {
    const t = window.__test;
    const p = t.player;
    const h = t.terrain?.getHeight ? (x, z) => t.terrain.getHeight(x, z) : () => 60;
    // Scan outward for a spot where the terrain sits under water (level 12
    // on lagoon) — blast there, camera hovers above looking at it.
    const LEVEL = 12;
    let bx = p.pos.x, bz = p.pos.z, found = false;
    for (let r = 20; r < 400 && !found; r += 20) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        const x = p.pos.x + Math.cos(a) * r, z = p.pos.z + Math.sin(a) * r;
        if (h(x, z) < LEVEL - 3) { bx = x; bz = z; found = true; break; }
      }
    }
    if (!found) return null;
    // Camera offset back from the blast, aimed at it exactly.
    const dx = p.pos.x - bx, dz = p.pos.z - bz;
    const d = Math.hypot(dx, dz) || 1;
    const cx = bx + (dx / d) * 22, cz = bz + (dz / d) * 22;
    const cy = Math.max(h(cx, cz) + 6, LEVEL + 8);
    p.pos.set(cx, cy, cz);
    p.vel.set(0, 0, 0);
    const fx = bx - cx, fy = (LEVEL + 1) - cy, fz = bz - cz;
    const fl = Math.hypot(fx, fy, fz);
    // forward = (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch))
    p.yaw = Math.atan2(-fx, -fz);
    p.pitch = Math.asin(fy / fl);
    p.syncMovement && p.syncMovement();
    p.markTeleport && p.markTeleport();
    return { bx, bz, cx, cz, cy };
  })()`) as { bx: number; bz: number; cx: number; cz: number; cy: number } | null;
  console.log('vantage', JSON.stringify(blast));
  if (!blast) { console.log('no water found'); }
  await new Promise(r => setTimeout(r, 2000));

  if (blast) {
    await client.page.evaluate(`(() => {
      const p = window.__test.player.pos;
      const dx = ${blast.bx} - p.x, dy = 12.5 - p.y, dz = ${blast.bz} - p.z;
      const d = Math.hypot(dx, dy, dz);
      const s = 55;
      // Dedicated rooms refuse raw aoeShot claims — fire a real shell
      // (server-simmed) that arcs into the water and explodes there.
      window.__test.networkManager.send({ type: 'shot', targetId: null,
        weaponType: 0, position: { x: p.x, y: p.y, z: p.z },
        velocity: { x: (dx / d) * s, y: (dy / d) * s + 3, z: (dz / d) * s },
        projectileId: 'e2e-water' });
    })()`);
  }
  // SwiftShader ~7x slow.
  for (const [ms, name] of [[3200, 'water_a'], [4500, 'water_b'], [6000, 'water_c']] as const) {
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
