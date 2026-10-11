/**
 * botLos — the line-of-sight sense: heightfield march + structure solids,
 * memoized on cell key. Extracted from botHunt.ts so the hunt decisions
 * read clean of the cache plumbing. The march is per-(bot,enemy) the
 * single priciest sense, so results cache on quantized endpoints (1.5m
 * cells) with a short TTL — answers only change when an endpoint actually
 * crosses a cell or the entry ages out.
 */
import type { BotVec, BrainCtx } from './botBrain.ts';
import { segSolidHit } from './solidWorld.ts';

// Generic eye-above-ground for LOS endpoints (shared/botClasses gives the
// per-class heights; this is the light tier's 1.8m — the low bound, so a
// heavy bot whose real eye rides higher only loses shots that start in
// the memoized probe, never sees ground through its own head).
export const BOT_EYE = 1.8;

// 10m cells + 1s TTL: answers only change when an endpoint crosses a
// cell. Skiers at 30-45m/s crossed a 3m cell every ~80ms — the memo
// missed constantly and every miss paid a ~dist/3-probe march. Bot
// senses are noisy by design; ±5m of endpoint fuzz is well under aim
// jitter, and a ridge thin enough to slip a 10m step rarely decides a
// 300m sightline.
const LOS_CELL = 10;
const LOS_TTL_MS = 1000;
const losMemo = new Map<number, { clear: boolean; until: number }>();

/** Test/map-change seam: answers memoize on cell keys that ignore the
 *  field, so a different terrain or a fresh harness must flush first. */
export function losMemoReset(): void { losMemo.clear(); }

/** Test seam: the bound is the only thing a scenario can assert. */
export function losMemoSize(): number { return losMemo.size; }

function losKey(ctx: BrainCtx, from: BotVec, to: BotVec): number {
  const ax = Math.round(from.x / LOS_CELL) + 2048;
  const az = Math.round(from.z / LOS_CELL) + 2048;
  const bx = Math.round(to.x / LOS_CELL) + 2048;
  const bz = Math.round(to.z / LOS_CELL) + 2048;
  // 12 bits per axis: 4096-cell range ≈ 6km — covers any field span.
  // Team rides the key: a gate transparent to its owners is opaque to
  // everyone else, so a shared answer would leak across sides.
  const t = ctx.team === 'alpha' ? 1 : ctx.team === 'bravo' ? 2 : 0;
  return (((ax * 4096 + az) * 4096 + bx) * 4096 + bz) * 4 + t;
}

/** Heightfield LOS — march the eye→target line, fail where ground rises
 *  above it. pos.y is eye-height on the client and near-feet on the
 *  server, so the eye point is whichever is higher of pos.y and
 *  ground+eye. Structures aren't modeled — callers don't hand them in —
 *  so this is "can I see over the terrain", plus a wall test when the
 *  host models structures — never full occlusion either way. */
function losMarch(ctx: BrainCtx, from: BotVec, to: BotVec): boolean {
  const dx = to.x - from.x, dz = to.z - from.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 4) {return true;} // point-blank: probes are coarser than the gap
  // The memo key may fuzz endpoints ±5m, but the march itself marches
  // the true segment at 6m — a ~10m-wide ridge must still be stepped
  // on, not hopped (a 10m stride literally skipped the tests' wall).
  const steps = Math.ceil(dist / 6);
  const y0 = Math.max(from.y + 0.4, ctx.groundY(from.x, from.z) + BOT_EYE);
  const y1 = Math.max(to.y + 0.4, ctx.groundY(to.x, to.z) + BOT_EYE);
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const x = from.x + dx * t, z = from.z + dz * t;
    if (ctx.groundY(x, z) > y0 + (y1 - y0) * t + 0.5) {return false;}
  }
  if (ctx.solids?.length &&
      segSolidHit({ x: from.x, y: y0, z: from.z }, { x: to.x, y: y1, z: to.z },
                  ctx.solids, ctx.solidIndex ?? undefined, ctx.team)) {return false;}
  return true;
}



export function losClear(ctx: BrainCtx, from: BotVec, to: BotVec): boolean {
  const key = losKey(ctx, from, to);
  const hit = losMemo.get(key);
  if (hit && hit.until > ctx.now) {return hit.clear;}
  const clear = losMarch(ctx, from, to);
  // Bound the map — combat bots reuse a narrow band of cells, and stale
  // entries self-expire anyway; sweep only when it balloons.
  if (losMemo.size > 4096) {
    for (const [k, v] of losMemo) {if (v.until <= ctx.now) {losMemo.delete(k);}}
    if (losMemo.size > 4096) {losMemo.clear();}
  }
  losMemo.set(key, { clear, until: ctx.now + LOS_TTL_MS });
  return clear;
}
