/**
 * visaudit.ts — live-scene geometry audit: walks every rendered object
 * each second and flags primitives that span absurd distances (the
 * "streak across the map" class) or sit far outside the field. Aims to
 * NAME the guilty system via probe tags / object names, not just count.
 *   bun _tools/e2e/visaudit.ts
 * Writes _tools/e2e/shots/visaudit_<n>.png on first violations.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const OUT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'shots');
// A legit trail/line segment is a few meters (a 200m/s projectile moves
// ~3m per 60fps sample). 60m flags teleports with slack below the
// ribbon guard's own trigger.
const SEG_LIMIT = 60;
const BOT_COUNT = 10;

const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=visaudit&bots=${BOT_COUNT}&net=ws`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AUDIT = `(() => {
  const t = window.__test;
  if (!t || !t.scene) return { ready: false };
  const out = { ready: true, offenders: [], scanned: 0, limit: ${SEG_LIMIT} };
  const LIM2 = out.limit * out.limit;
  const tagOf = (o) => o.userData?.probe?.kind || o.userData?.kind || o.name || o.type;
  t.scene.traverse((o) => {
    const geo = o.geometry;
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    const arr = geo.attributes.position.array;
    if (!arr || !arr.length) return;
    o.updateWorldMatrix(true, false);
    const m = o.matrixWorld.elements;
    const X = (v) => m[0]*arr[v*3] + m[4]*arr[v*3+1] + m[8]*arr[v*3+2] + m[12];
    const Y = (v) => m[1]*arr[v*3] + m[5]*arr[v*3+1] + m[9]*arr[v*3+2] + m[13];
    const Z = (v) => m[2]*arr[v*3] + m[6]*arr[v*3+1] + m[10]*arr[v*3+2] + m[14];
    let maxEdge = 0, at = [0,0,0], nan = 0;
    const check = (a, b) => {
      const dx = X(a)-X(b), dy = Y(a)-Y(b), dz = Z(a)-Z(b);
      const e = dx*dx + dy*dy + dz*dz;
      if (e > maxEdge) { maxEdge = e; at = [X(a)|0, Y(a)|0, Z(a)|0]; }
      if (!isFinite(e)) nan++;
    };

    if (o.isLine || o.isLineSegments) {
      // Real segment pairs — the only honest measure for lines.
      out.scanned++;
      const idx = geo.index ? geo.index.array : null;
      const nseg = idx ? idx.length/2 : arr.length/6;
      const step = Math.max(1, Math.floor(nseg/2000));
      for (let s = 0; s < nseg; s += step) {
        check(idx ? idx[s*2] : s*2, idx ? idx[s*2+1] : s*2+1);
      }
    } else if (o.userData?.probe?.kind === 'trailBatch') {
      // Ribbon slots: only consecutive-sample edges within a quad matter.
      out.scanned++;
      const VERTS = 96; // RIBBON_SAMPLES*2
      const nslot = Math.floor(arr.length / 3 / VERTS);
      const dr = geo.drawRange ? geo.drawRange.count : Infinity;
      const usedSlots = Math.min(nslot, Math.floor(dr / ((VERTS/2 - 1) * 6)) + 1);
      for (let s = 0; s < usedSlots; s++) {
        const base = s * VERTS;
        for (let i = 0; i < VERTS/2 - 1; i++) check(base + i*2, base + i*2 + 2);
      }
    } else if (o.isInstancedMesh) {
      // Giant or off-field instances — matrix rows give scale+position.
      out.scanned++;
      const im = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        const b = i*16;
        const sx = Math.hypot(im[b], im[b+1], im[b+2]);
        if (!isFinite(sx)) nan++;
        if (sx > LIM2) { maxEdge = Math.max(maxEdge, sx); at = [im[b+12]|0, im[b+13]|0, im[b+14]|0]; }
      }
    } else {
      return; // terrain/sky/sprites legitimately span the world
    }
    if (maxEdge > LIM2 || nan) {
      out.offenders.push({ tag: tagOf(o), type: o.type, edge: +Math.sqrt(maxEdge).toFixed(0),
        at, verts: arr.length/3, nan, visible: o.visible });
    }
  });
  return out;
})()`;

try {
  await client.waitFor(`t.player && t.player.pos`, 30000);
  let shotN = 0;
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const r = await client.page.evaluate(AUDIT) as { ready: boolean; offenders?: { tag: string; type: string; edge: number; at: number[]; verts: number; visible: boolean }[]; scanned?: number };
    if (!r.ready) continue;
    const fresh = (r.offenders ?? []).filter((o) => {
      const k = `${o.tag}|${o.type}|${Math.round(o.edge / 100)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (fresh.length) {
      console.log(`t=${i}s offenders:`, JSON.stringify(fresh));
      if (shotN < 3) {
        mkdirSync(OUT, { recursive: true });
        await client.page.screenshot({ path: join(OUT, `visaudit_${shotN}.png`) });
        console.log('wrote', join(OUT, `visaudit_${shotN}.png`));
        shotN++;
      }
    }
    if (i % 10 === 0) console.log(`t=${i}s scanned=${r.scanned} offenders=${r.offenders?.length}`);
  }
} finally {
  await closeClient(client);
  stack.down();
}
