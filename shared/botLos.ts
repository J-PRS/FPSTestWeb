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

// Must equal EYE_OFFSET (shared/constants): GameBot.position IS the eye
// point, and RemotePlayer renders feet at pos.y - EYE_OFFSET.
export const BOT_EYE = 1.8;

const LOS_CELL = 1.5;
const LOS_TTL_MS = 800;
const losMemo = new Map<number, { clear: boolean; until: number }>();

function losKey(from: BotVec, to: BotVec): number {
  const ax = Math.round(from.x / LOS_CELL) + 2048;
  const az = Math.round(from.z / LOS_CELL) + 2048;
  const bx = Math.round(to.x / LOS_CELL) + 2048;
  const bz = Math.round(to.z / LOS_CELL) + 2048;
  // 12 bits per axis: 4096-cell range ≈ 6km — covers any field span.
  return ((ax * 4096 + az) * 4096 + bx) * 4096 + bz;
}

export function losClear(ctx: BrainCtx, from: BotVec, to: BotVec): boolean {
  const key = losKey(from, to);
  const hit = losMemo.get(key);
  if (hit && hit.until > ctx.now) return hit.clear;
  const clear = losMarch(ctx, from, to);
  // Bound the map — combat bots reuse a narrow band of cells, and stale
  // entries self-expire anyway; sweep only when it balloons.
  if (losMemo.size > 4096) {
    for (const [k, v] of losMemo) if (v.until <= ctx.now) losMemo.delete(k);
    if (losMemo.size > 4096) losMemo.clear();
  }
  losMemo.set(key, { clear, until: ctx.now + LOS_TTL_MS });
  return clear;
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
  if (dist < 4) return true; // point-blank: probes are coarser than the gap
  const steps = Math.ceil(dist / 3);
  const y0 = Math.max(from.y + 0.4, ctx.groundY(from.x, from.z) + BOT_EYE);
  const y1 = Math.max(to.y + 0.4, ctx.groundY(to.x, to.z) + BOT_EYE);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t, z = from.z + dz * t;
    if (ctx.groundY(x, z) > y0 + (y1 - y0) * t + 0.5) return false;
  }
  if (ctx.solids?.length &&
      segSolidHit({ x: from.x, y: y0, z: from.z }, { x: to.x, y: y1, z: to.z },
                  ctx.solids, ctx.solidIndex ?? undefined)) return false;
  return true;
}
