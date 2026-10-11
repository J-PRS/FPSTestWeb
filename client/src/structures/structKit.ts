// structKit — base-structure primitives for Tribes-style bases.
// Rides weaponKit's loft machinery (it's scale-agnostic); the pieces here
// are the T:A kit-of-parts: raked skirt, tiered tower, dome, pad, glow band.
// Language rules (from T1/T2/TA research): scale IS the detail — nothing
// under ~0.5m; every structure gets ONE emissive accent; silhouette sells
// function (tower=flag, dome=gen, plate=pad).

import * as THREE from 'three';
import {
  mkLoft, mkRevolve, mkAnnulus, profOct, profCircle, morphLoft,
  scaleRing, tubePath,
  type LoftSection, type Ring2,
} from '../entities/viewmodel/weaponKit';

// — palette — concrete gunmetal + dark trim + one glow line per structure —
export const hullMat  = new THREE.MeshStandardMaterial({ color: 0x8A_8F_96, roughness: 0.75, metalness: 0.35 });
export const trimMat  = new THREE.MeshStandardMaterial({ color: 0x3A_3D_44, roughness: 0.6,  metalness: 0.6  });
export const deckMat  = new THREE.MeshStandardMaterial({ color: 0x6D_70_78, roughness: 0.85, metalness: 0.25 });
export const glowCyan = new THREE.MeshBasicMaterial({ color: 0x59_F2_FF });
export const glowAmber = new THREE.MeshBasicMaterial({ color: 0xFF_B0_40 });
export const darkMat  = new THREE.MeshStandardMaterial({ color: 0x14_15_18, roughness: 0.9,  metalness: 0.2  });

/** Add mesh w/ shadows on — every kit piece goes through this. */
function add(g: THREE.Group, m: THREE.Mesh, x = 0, y = 0, z = 0): THREE.Mesh {
  m.position.set(x, y, z);
  m.receiveShadow = true;
  m.castShadow = m.receiveShadow;
  g.add(m);
  return m;
}

// Vertical axis is Y here (buildings) — weaponKit lofts along Z, so kit
// pieces build in Z then rotate -90° on X. rotUp() is the one-line adapter.
function rotUp(m: THREE.Mesh): THREE.Mesh {
  m.rotation.x = -Math.PI / 2;
  return m;
}

// WINDING CONTRACT: mkLoft's quad order is outward-facing only when
// sections are listed HIGH-z FIRST (the weapon convention: rear → muzzle).
// Since our buildings list top-first anyway this reads naturally — but a
// bottom→top section list skins the mesh inside-out.
/** Sections helper: top → bottom ordering, the winding mkLoft wants. */
export const topDown = (...secs: LoftSection[]): LoftSection[] =>
  secs.sort((a, b) => b.z - a.z);

/** Raked talus skirt — the T2 "grounded into the mountain" flare.
 *  ring = top profile, flare = foot radius multiplier (1.4 ≈ 40% overhang).
 *  bury = how far below origin the foot continues — on uneven terrain the
 *  skirt keeps going down into the ground instead of floating on stilts. */
export function skirt(ring: Ring2, height: number, flare = 1.4, mat = hullMat, bury = 0): THREE.Mesh {
  const foot = scaleRing(ring, flare);
  const m = mkLoft(topDown(
    { z: height, ring },
    { z: height * 0.85, ring },
    { z: 0, ring: foot },
    // Buried section NECKS DOWN instead of staying full-width — on a
    // slope steeper than the bury depth an exposed end reads as a root
    // piling driven into the ground, not a flat slab underside.
    ...(bury ? [
      { z: -bury * 0.4, ring: scaleRing(ring, flare * 1.02) },
      { z: -bury, ring: scaleRing(ring, flare * 0.3) },
    ] : []),
  ), mat);
  return rotUp(m);
}

/** Tiered tower shaft — fat chamfered column, tiers get slimmer going up.
 *  tiers: [{w, h}] bottom→top; each step gets a trim ledge ring. */
export function towerShaft(w: number, h: number, tiers = 2, mat = hullMat): THREE.Group {
  const g = new THREE.Group();
  let y = 0;
  for (let i = 0; i < tiers; i += 1) {
    const tw = w * (1 - i * 0.12);
    const th = h / tiers;
    const secs: LoftSection[] = topDown(
      { z: th, ring: profOct(tw, tw, tw * 0.12) },
      { z: 0, ring: profOct(tw, tw, tw * 0.12) },
    );
    const seg = mkLoft(secs, mat);
    rotUp(seg);
    seg.position.y = y;
    g.add(seg);
    y += th;
  }
  return g;
}

/** Chamfered cap plate for a tower top — slight overhang = cornice line. */
export function capPlate(w: number, over = 0.06, thick = 0.6, mat = trimMat): THREE.Mesh {
  const ow = w * (1 + over);
  const m = mkLoft(topDown(
    { z: thick, ring: profOct(ow * 0.94, ow * 0.94, ow * 0.12) },
    { z: thick * 0.6, ring: profOct(ow, ow, ow * 0.1) },
    { z: 0, ring: profOct(ow, ow, ow * 0.1) },
  ), mat);
  return rotUp(m);
}

/** Emissive band inset between tiers — the ONE glow accent (T:A window line). */
export function windowBand(w: number, h = 0.5, glow = glowCyan): THREE.Mesh {
  const m = mkLoft(topDown(
    { z: h, ring: profOct(w * 1.005, w * 1.005, w * 0.12) },
    { z: 0, ring: profOct(w * 1.005, w * 1.005, w * 0.12) },
  ), glow);
  return rotUp(m);
}

/** Octagonal landing/flag pad — plate + recessed centre disc + glow rim. */
export function pad(r: number, thick = 0.5, glow = glowCyan): THREE.Group {
  const g = new THREE.Group();
  const plate = mkLoft(topDown(
    { z: thick, ring: profOct(r * 2, r * 2, r * 0.25) },
    { z: 0, ring: profOct(r * 2.06, r * 2.06, r * 0.25) },
  ), deckMat);
  rotUp(plate);
  g.add(plate);
  // glow rim — a thin annulus wrapped on the plate's edge face
  const rim = mkAnnulus(profOct(r * 2, r * 2, r * 0.25), profOct(r * 1.96, r * 1.96, r * 0.24), thick - 0.15, thick, glow);
  rim.rotation.x = -Math.PI / 2;
  g.add(rim);
  return g;
}

/** Faceted dome — generator / sensor read. r = base radius. */
export function dome(r: number, mat = hullMat): THREE.Mesh {
  const prof: [number, number][] = [];
  const N = 10;
  for (let i = 0; i <= N; i += 1) {
    const a = (i / N) * Math.PI / 2;
    prof.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return rotUp(mkRevolve(prof, mat, 12, true));
}

/** Antenna mast — tapered shaft + guy wires + beacon tip. */
export function mast(h: number, r = 0.35, mat = trimMat, glow = glowAmber): THREE.Group {
  const g = new THREE.Group();
  const shaft = mkLoft(topDown(
    { z: h, ring: profCircle(r * 0.5, 8) },
    { z: h * 0.7, ring: profCircle(r, 8) },
    { z: 0, ring: profCircle(r * 2.2, 8) },
  ), mat);
  rotUp(shaft);
  g.add(shaft);
  // beacon — the mast's emissive accent
  const tip = new THREE.Mesh(new THREE.SphereGeometry(r * 1.1, 8, 6), glow);
  tip.position.y = h + r * 0.5;
  g.add(tip);
  return g;
}

/** Thin lit bar — parapet strips, door slots, bezel lines. The kit's
 *  ONE sanctioned non-silhouette accent, in one place. Lies along X. */
export function glowStrip(len: number, h: number, depth = 0.12, glow = glowCyan): THREE.Mesh {
  const m = mkLoft(topDown(
    { z: h, ring: profOct(len, depth, depth * 0.35) },
    { z: 0, ring: profOct(len, depth, depth * 0.35) },
  ), glow);
  return rotUp(m);
}

/** Wall terminator — squat battered post that closes a curtain's open
 *  loft end. Without one a wall run just stops mid-air, hollow end on
 *  show. ~0.4m taller than the wall it caps. */
export function endPost(h = 4.2, w = 3): THREE.Group {
  const g = new THREE.Group();
  const post = mkLoft(topDown(
    { z: h + 0.4, ring: profOct(w * 0.82, w * 0.82, w * 0.16) },
    { z: h,       ring: profOct(w * 0.9,  w * 0.9,  w * 0.18) },
    { z: 0,       ring: profOct(w,        w,        w * 0.2)  },
  ), hullMat);
  rotUp(post);
  g.add(post);
  // A post is solid geometry — without the sidecar it renders but never
  // collides when folded into a compound (the KIT_HULLS table assumed it
  // did; that drift is what the parity test exists to catch).
  g.userData.hulls = [{ pos: { x: 0, y: (h + 0.4) / 2, z: 0 }, size: { x: w, y: h + 0.4, z: w } } satisfies HullBox];
  return g;
}

/** Collision sidecar — a coarse box in the piece's LOCAL frame, same
 *  shape as a 'hull' StructureSpec. Builders attach their own via
 *  userData.hulls so map specs stay in step with the visuals; compound()
 *  folds them into compound space. */
export interface HullBox {
  pos: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  rotY?: number;
  /** Hemisphere radius — dome cap, not a box (see KitHull.dome). */
  dome?: number;
}

/** Compound assembly — [piece, x, z, rotY?] entries placed in local
 *  space; child userData.hulls are rotated+translated into compound
 *  space so a composed base emits ready-made 'hull' specs. */
export function compound(
  entries: (readonly [THREE.Object3D, number, number] | readonly [THREE.Object3D, number, number, number])[],
): THREE.Group {
  const g = new THREE.Group();
  const hulls: HullBox[] = [];
  for (const [m, x, z, rotY = 0] of entries) {
    m.position.set(x, 0, z);
    m.rotation.y = rotY;
    g.add(m);
    const c = Math.cos(rotY), s = Math.sin(rotY);
    for (const h of (m.userData.hulls as HullBox[] | undefined) ?? []) {
      hulls.push({
        pos: { x: h.pos.x * c + h.pos.z * s + x, y: h.pos.y, z: -h.pos.x * s + h.pos.z * c + z },
        size: h.size,
        rotY: rotY + (h.rotY ?? 0) || undefined,
        dome: h.dome,
      });
    }
  }
  if (hulls.length > 0) {g.userData.hulls = hulls;}
  return g;
}

/** Approach ramp — battered wedge, ground to deck height, running
 *  +Z low→high. Deliberately long and shallow: it should read skiable,
 *  not stair-stepped. Carries its own box hull. */
export function ramp(w = 5, len = 12, rise = 2.5): THREE.Group {
  const g = new THREE.Group();
  const wedge = mkLoft([
    { z: len, ring: profOct(w, rise, Math.min(0.4, rise * 0.2)), dy: rise / 2 },
    { z: 0,   ring: profOct(w, 0.4, 0.15), dy: 0.2 },
  ], hullMat);
  wedge.castShadow = true;
  wedge.receiveShadow = true;
  g.add(wedge);
  g.userData.hulls = [{ pos: { x: 0, y: rise / 2, z: len / 2 }, size: { x: w, y: rise, z: len } } satisfies HullBox];
  return g;
}

/** Minimal ground interface — Terrain and the lab stub both satisfy it. */
export interface GroundLike {
  getHeight(x: number, z: number): number;
  getNormal(x: number, z: number): THREE.Vector3;
}

const _seatN = new THREE.Vector3();
const _seatQ = new THREE.Quaternion();
const _seatUp = new THREE.Vector3(0, 1, 0);
/** Seat a piece on terrain — y at ground level and tilted toward the
 *  terrain normal, clamped to `maxTilt` rad: skirts already bury so the
 *  tilt only needs to stop a compound straddling a slope badly. */
export function seatOn(g: THREE.Object3D, ground: GroundLike, x: number, z: number, maxTilt = 0.35): THREE.Object3D {
  g.position.set(x, ground.getHeight(x, z), z);
  const n = _seatN.copy(ground.getNormal(x, z));
  const ang = Math.acos(THREE.MathUtils.clamp(n.y, -1, 1));
  if (ang > 1e-4) {
    _seatQ.setFromUnitVectors(_seatUp, n);
    g.quaternion.slerp(_seatQ, Math.min(1, maxTilt / ang));
  }
  return g;
}

/** Radial placement — n slots around a circle, calls fn(i, angle) and
 *  parents the result at the slot, rotated to face out. Pads around a
 *  dome, turret spokes, radial courtyards. */
export function polar(n: number, r: number, fn: (i: number, a: number) => THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    const m = fn(i, a);
    m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    m.rotation.y = -a;
    g.add(m);
  }
  return g;
}

/** The composed pieces live in structures.ts — this kit stays primitive. */
