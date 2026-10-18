import * as THREE from 'three';
import { blastBurst } from './vfx.js';
import type { Terrain } from '../world/terrain.js';
import { getWaterLevel, addWaterRipple } from '../world/waterSurface.js';

// Water splash on blast/impact — one whitewater column + a surface sheet,
// all batched quarks bursts (shared draw calls, zero pooled meshes).
// `mult` is the caller's blast-size factor (weapon radius / bullet scale),
// so a mortar throws a geyser and a slug throws a pfft. A shell that
// fused on the seabed still erupts the column at the surface point —
// pos.y only gates WHETHER we splash, never where.
// Water reads OPAQUE (aerated foam scatters light back) — normal blend,
// velocity-stretched droplets, hard gravity. Mist is a garnish, never
// a layer; additive glow would read as vapor, not water.

const _at = new THREE.Vector3();

/** Splash the sea surface at (pos.x, level, pos.z) when `pos` is close
 *  enough to it — false on dry maps, dry land, or blasts too far off. */
export function waterSplashAt(pos: THREE.Vector3, mult: number, terrain?: Terrain): boolean {
  const level = getWaterLevel();
  if (level === undefined) {return false;}
  // Band scales with blast size: a big blast reaches the surface from
  // higher up; a slug only splashes right at the waterline.
  if (Math.abs(pos.y - level) > 3 + 4 * mult) {return false;}
  // Shoreline check — a blast over beach above the waterline throws sand,
  // not spray.
  if (terrain && terrain.getHeight(pos.x, pos.z) > level + 0.5) {return false;}
  _at.set(pos.x, level, pos.z);
  addWaterRipple(_at.x, _at.z, 4 + 3 * mult); // the surface itself answers

  blastBurst(_at, { // displaced-water dome — the white mound that bursts first
    count: Math.floor(8 * mult),
    elvBase: 0, elvSpan: Math.PI * 0.5,
    spdMin: 1, spdMax: 4 * Math.sqrt(mult), vy: 3,
    lifeMin: 0.2, lifeMax: 0.45,
    sizeMin: 1.2 * mult, sizeMax: 2.6 * mult,
    gravity: -8, // it dies before it falls — a mound, not droplets
    c1: [0.9, 0.97, 1], c2: [0.5, 0.68, 0.72],
    opacity: 0.85, stretched: false, stagger: 0.03,
  }, false);
  blastBurst(_at, { // geyser — wide cone (~80°) so it throws laterally too,
    // but vy dominates: the mass still goes UP. Apex ~5m per mult, lives
    // long enough to crest and visibly rain back down.
    count: Math.floor(26 * mult),
    elvBase: 0.22, elvSpan: Math.PI * 0.55, // elv centered at ~0.22·99°:
    // ~a quarter of the burst throws sideways/slightly down, rest arcs up
    spdMin: 4, spdMax: 14 * Math.sqrt(mult), vy: 18 * Math.sqrt(mult),
    lifeMin: 0.6, lifeMax: 1.6,
    sizeMin: 0.7 * mult, sizeMax: 1.8 * mult,
    gravity: -30,
    c1: [0.95, 1, 1], c2: [0.45, 0.62, 0.68],
    opacity: 0.95, stretched: true, stretchLen: 6, stagger: 0.08,
  }, false);
  blastBurst(_at, { // crown sheet — droplets skimming outward on the surface
    count: Math.floor(12 * mult),
    planar: true, elvBase: 0, elvSpan: 0,
    spdMin: 10, spdMax: 26 * Math.sqrt(mult), vy: 2,
    lifeMin: 0.25, lifeMax: 0.55,
    sizeMin: 0.25 * mult, sizeMax: 0.6 * mult,
    gravity: -25,
    c1: [0.85, 0.95, 0.98], c2: [0.4, 0.55, 0.6],
    opacity: 0.85, stretched: true, stretchLen: 4, stagger: 0.05,
  }, false);
  blastBurst(_at, { // fine spray — thin fast streaks riding the column
    count: Math.floor(20 * mult),
    elvBase: 0.1, elvSpan: Math.PI * 0.5,
    spdMin: 10, spdMax: 28 * Math.sqrt(mult), vy: 5,
    lifeMin: 0.12, lifeMax: 0.3,
    sizeMin: 0.1 * mult, sizeMax: 0.25 * mult,
    gravity: -50,
    c1: [0.9, 0.98, 1], c2: [0.5, 0.7, 0.75],
    opacity: 0.9, stretched: true, stretchLen: 7, stagger: 0.08,
  }, false);
  return true;
}

// Waterline crossings — keyed on the caller's pos VECTOR (each actor's
// pos/rp.position object is stable across frames), so per-actor state
// costs a WeakMap lookup and no plumbing through three call sites.
const _cross = new WeakMap<THREE.Vector3, { above: boolean; t: number }>();

/** Per-frame check from the shared locomotion pass — splashes on entry
 *  AND exit, scaled by vertical speed. Throttled so bobbing at the
 *  waterline doesn't machine-gun bursts. */
export function waterCrossingFx(pos: THREE.Vector3, velY: number): void {
  const level = getWaterLevel();
  if (level === undefined) {return;}
  const above = pos.y > level + 0.15;
  const st = _cross.get(pos);
  if (!st) {
    _cross.set(pos, { above, t: 0 });
    return;
  }
  const now = performance.now();
  if (above !== st.above && now - st.t > 400 && Math.abs(velY) > 2) {
    st.t = now;
    waterSplashAt(pos, Math.min(1.5, 0.4 + Math.abs(velY) * 0.08));
  }
  st.above = above;
}
