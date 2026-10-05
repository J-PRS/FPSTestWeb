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
const hullMat  = new THREE.MeshStandardMaterial({ color: 0x8A8F96, roughness: 0.75, metalness: 0.35 });
export const trimMat  = new THREE.MeshStandardMaterial({ color: 0x3A3D44, roughness: 0.6,  metalness: 0.6  });
export const deckMat  = new THREE.MeshStandardMaterial({ color: 0x6D7078, roughness: 0.85, metalness: 0.25 });
const glowCyan = new THREE.MeshBasicMaterial({ color: 0x59F2FF });
const glowAmber = new THREE.MeshBasicMaterial({ color: 0xFFB040 });
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
const topDown = (...secs: LoftSection[]): LoftSection[] =>
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
  for (let i = 0; i < tiers; i++) {
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
    // trim ledge between tiers — the horizontal line towers need
    if (i < tiers - 1) {
      const ledge = mkLoft(topDown(
        { z: 0.25, ring: profOct(tw * 1.04, tw * 1.04, tw * 0.13) },
        { z: -0.25, ring: profOct(tw * 1.04, tw * 1.04, tw * 0.13) },
      ), trimMat);
      rotUp(ledge);
      ledge.position.y = y + th;
      g.add(ledge);
    }
    y += th;
  }
  return g;
}

/** Chamfered cap plate for a tower top — slight overhang = cornice line. */
export function capPlate(w: number, over = 0.06, thick = 0.6, mat = trimMat): THREE.Mesh {
  const ow = w * (1 + over);
  const m = mkLoft(morphLoft(topDown(
    { z: thick, ring: profOct(ow * 0.94, ow * 0.94, ow * 0.12) },
    { z: thick * 0.6, ring: profOct(ow, ow, ow * 0.1) },
    { z: 0, ring: profOct(ow, ow, ow * 0.1) },
  ), 2), mat);
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
function pad(r: number, thick = 0.5, glow = glowCyan): THREE.Group {
  const g = new THREE.Group();
  const plate = mkLoft(morphLoft(topDown(
    { z: thick, ring: profOct(r * 2, r * 2, r * 0.25) },
    { z: 0, ring: profOct(r * 2.06, r * 2.06, r * 0.25) },
  ), 2), deckMat);
  rotUp(plate);
  g.add(plate);
  // glow rim — a thin annulus wrapped on the plate's edge face
  const rim = mkAnnulus(profOct(r * 2, r * 2, r * 0.25), profOct(r * 1.96, r * 1.96, r * 0.24), thick - 0.15, thick, glow);
  rim.rotation.x = -Math.PI / 2;
  g.add(rim);
  // recessed centre disc (flag-stand socket or landing target)
  const disc = mkLoft(topDown({ z: 0.06, ring: profCircle(r * 0.4, 16) }, { z: 0, ring: profCircle(r * 0.4, 16) }), darkMat);
  rotUp(disc);
  disc.position.y = thick;
  g.add(disc);
  return g;
}

/** Faceted dome — generator / sensor read. r = base radius. */
function dome(r: number, mat = hullMat): THREE.Mesh {
  const prof: [number, number][] = [];
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI / 2;
    prof.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return rotUp(mkRevolve(prof, mat, 12, true));
}

/** Antenna mast — tapered shaft + guy wires + beacon tip. */
function mast(h: number, r = 0.35, mat = trimMat): THREE.Group {
  const g = new THREE.Group();
  const shaft = mkLoft(morphLoft(topDown(
    { z: h, ring: profCircle(r * 0.5, 8) },
    { z: h * 0.7, ring: profCircle(r, 8) },
    { z: 0, ring: profCircle(r * 2.2, 8) },
  ), 3), mat);
  rotUp(shaft);
  g.add(shaft);
  // beacon — the mast's emissive accent
  const tip = new THREE.Mesh(new THREE.SphereGeometry(r * 1.1, 8, 6), glowAmber);
  tip.position.y = h + r * 0.5;
  g.add(tip);
  return g;
}

/** The composed pieces live in structures.ts — this kit stays primitive. */
