/**
 * mapthumbs.ts — pre-render a lobby-picker thumbnail for every map spec.
 *   bun _tools/e2e/mapthumbs.ts [onlyMap]
 *
 * Vantage is derived from each spec's arena/bases: an oblique aerial
 * above the arena center, pitched down so terrain + interiors read as a
 * map, not a skyline. Writes maps/thumbs/<name>.png — served by
 * mapBinRoute to the lobby MAP preview.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MAPS = join(REPO, 'maps');
const OUT = join(MAPS, 'thumbs');
const only = process.argv[2];

interface Spec {
  arena?: { x?: number; z?: number; radius?: number };
  bases?: Record<string, { x?: number; z?: number }>;
  flags?: Record<string, { x?: number; z?: number }>;
  structures?: { pos: { x: number; z: number } }[];
  spawns?: { x?: number; z?: number }[];
}

const names = readdirSync(MAPS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .filter((n) => !only || n === only)
  .toSorted();
if (!names.length) throw new Error(only ? `no spec maps/${only}.json` : 'no specs found');

const stack = await upStack();
console.log('stack server', stack.serverPort, 'client', stack.clientPort);
mkdirSync(OUT, { recursive: true });

for (const name of names) {
  let spec: Spec = {};
  try { spec = JSON.parse(readFileSync(join(MAPS, `${name}.json`), 'utf8')); } catch { /* odd spec */ }
  const cx = spec.arena?.x ?? 0;
  const cz = spec.arena?.z ?? 0;
  const r = spec.arena?.radius ?? 400;
  // A base map's identity is the fortress, not the midfield: aim at the
  // alpha base (flag stand when authored) with the camera pulled back
  // toward the arena center — compounds read as architecture, open
  // maps still get the oblique aerial.
  const base = spec.flags?.alpha ?? spec.bases?.alpha;
  let vx: number, vz: number, aimX = cx, aimZ = cz, lift = Math.max(60, r * 0.35);
  if (base?.x !== undefined && base.z !== undefined) {
    aimX = base.x; aimZ = base.z;
    // Camera ~35% of the way toward midfield, lifted — the wall face and
    // courtyard read, midfield falls off behind into the frame's top.
    const mx = cx - base.x, mz = cz - base.z;
    const d = Math.hypot(mx, mz) || 1;
    // Pullback scaled to the compound's own footprint — a 20-piece base
    // needs ~1.4x its radius behind the wall to fill the frame; a lone
    // flag stand wants to be close or it reads as dirt with a speck.
    let extent = 0;
    for (const s of spec.structures ?? []) {
      const sd = Math.hypot(s.pos.x - base.x, s.pos.z - base.z);
      if (sd < 160) extent = Math.max(extent, sd);
    }
    const back = Math.min(Math.max(extent * 1.4, 70), 150, d * 0.5);
    vx = base.x + (mx / d) * back;
    vz = base.z + (mz / d) * back;
    lift = Math.max(40, back * 0.6);
  } else {
    vx = cx + r * 0.4;
    vz = cz + r * 0.4;
  }
  const yaw = Math.atan2(aimX - vx, aimZ - vz); // face the aim point (three yaw = atan2(dx,dz) per sim convention)

  const url = stack.clientUrl(`&room=${name}&bots=0&net=ws`);
  const client = await launchClient(url);
  // Pitch to put the aim point mid-frame — geometry-derived, not a magic
  // angle, so the base vantage and the midfield fallback both compose.
  const horizD = Math.hypot(aimX - vx, aimZ - vz) || 1;
  const pitch = -Math.atan2(lift, horizD);
  try {
    await client.waitFor(`t.player && t.player.pos`, 30000);
    await new Promise((res) => setTimeout(res, 4000)); // terrain + interiors settle
    await client.page.evaluate(`(() => {
      const p = window.__test.player;
      const h = window.__test.terrain?.heightAt ? window.__test.terrain.heightAt(${vx}, ${vz}) : 60;
      p.pos.set(${vx}, h + ${lift}, ${vz});
      p.vel.set(0, 0, 0);
      p.yaw = ${yaw}; p.pitch = ${pitch};
      p.syncMovement && p.syncMovement();
      p.markTeleport && p.markTeleport();
      // gameLoop re-shows the viewmodel every frame — only the
      // spectator flag keeps the gun out of the shot.
      p.status.spectating = true;
    })()`);
    await new Promise((res) => setTimeout(res, 2500));
    // Thumbs are scenery, not UI — everything but the render canvas hides.
    await client.page.evaluate(`(() => {
      for (const el of document.body.children) {
        if (el.tagName !== 'CANVAS') el.style.display = 'none';
      }
      document.body.style.background = '#000';
    })()`);
    await new Promise((res) => setTimeout(res, 300));
    const file = join(OUT, `${name}.png`);
    await client.page.screenshot({ path: file });
    console.log('thumb', name);
  } catch (e) {
    console.log('thumb FAILED', name, (e as Error).message);
  } finally {
    await closeClient(client);
  }
}
stack.down();
console.log('done — wrote to maps/thumbs/');
