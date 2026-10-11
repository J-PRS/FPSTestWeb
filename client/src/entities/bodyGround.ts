import type { Terrain } from '../world/terrain.js';

// Render-side ground clearance for a player body. Physics only promises
// the feet POINT sits on terrain under (x,z) — the rendered mesh is a
// ~0.5-0.8m wide rigid column, so on a slope the uphill half of the
// footprint sinks by slope×radius (~1m on steep faces: legs vanish into
// the hillside). Remote placement is worse: interp copies Hermite-
// sampled wire positions with no ground guarantee at all (the curve dips
// under crests between snapshots; converge steps have no clamp).
//
// The fix samples the body footprint ring and lifts the mesh to the
// highest terrain under it — a slight hover on steep ground reads far
// better than a buried model, and it self-heals any netcode dip.

/** Default footprint ring — the medium capsule; callers pass the class
 *  radius when they have it (heavies bury deeper uphill). */
const RING = 0.62;
/** Lift cap: a footprint sample higher than this is a wall/ledge beside
 *  the body, not ground under it — lifting into it reads as levitation.
 *  2.5 covers the deepest wire dip observed (1.9m, MARA-03 soak) plus
 *  margin; the server-side chord clamp should hold dips under ~0.5. */
const MAX_LIFT = 2.5;
/** Pad over the sampled ground: the rendered triangle chord can sit a
 *  couple cm under the bilinear heightfield quad on rough cells — feet
 *  landing exactly at sample height would still nick. */
const PAD = 0.03;
/** Skip the ring samples entirely above this clearance — airborne bodies
 *  can't bury (this is also the cost gate: one height probe per frame). */
const SKIP_ABOVE = 2.5;

/** Live structure-top query — registered by game/structureSpecs on
 *  every collider rebuild (kept here so entities never import the game
 *  side: remoteAnim → structureSpecs → botBrain → RemotePlayer cycles). */
type StructAt = (x: number, z: number, maxTop?: number) => number;
let structAt: StructAt | undefined;
export function setStructureTopAt(fn: StructAt | undefined): void { structAt = fn; }

/** Ground clearance lift for a body standing at (x,z) with logical feet
 *  at feetY. `structAt` is the live structure-top query (deck lips and
 *  dome caps bury bodies exactly like slopes do); its samples are capped
 *  at feetY + MAX_LIFT so a ceiling never reads as floor. Returns ≥0 —
 *  the amount the RENDERED feet rise, never the logical position (aim,
 *  hits and shadows stay on sim truth). */
export function bodyGroundLift(terrain: Terrain, x: number, z: number, feetY: number, radius = RING): number {
  const maxTop = feetY + MAX_LIFT;
  // getRenderedHeight, not just the field: the drawn level-0 chord
  // bridges gullies ABOVE the smooth field — a lift computed off the
  // field alone still leaves the mesh under the visible surface there.
  const s = (px: number, pz: number): number =>
    Math.max(terrain.getRenderedHeight(px, pz), structAt?.(px, pz, maxTop) ?? -Infinity);
  const c = s(x, z);
  if (feetY > c + SKIP_ABOVE) {return 0;}
  const r = radius, rd = radius * Math.SQRT1_2; // diagonals reach the same ring
  const g = Math.max(c,
    s(x + r, z), s(x - r, z), s(x, z + r), s(x, z - r),
    s(x + rd, z + rd), s(x - rd, z + rd), s(x + rd, z - rd), s(x - rd, z - rd));
  return Math.min(Math.max(g + PAD - feetY, 0), MAX_LIFT);
}

/** Ease a per-body lift: snaps UP instantly (a buried frame is the bug),
 *  eases DOWN over ~120ms so walking off a crest doesn't pop. Mutates
 *  the holder's `cur`. */
export function easeGroundLift(cur: number, target: number, dt: number): number {
  return target > cur ? target : cur + (target - cur) * Math.min(1, dt * 8);
}
