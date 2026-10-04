// Server-owned pickup identity — pickups are diegetic now: every kind is
// the same tumbling physics gem (Nugget), and the kind reads purely by
// color. This table is the one place those colors live so the body tint
// and the collect burst can't drift apart.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PickupKind } from '../../../shared/pickups.js';
import { blastBurst } from '../effects/vfx.js';

export const PICKUP_ACCENT: Record<PickupKind, number> = {
  gem:   0xffd54a, // warm gold
  tag:   0xff3355, // dog-tag red
  heal:  0x44ff66, // medkit green
  armor: 0xffaa22, // plating orange
  regen: 0x66ffee, // regen teal
  dd:    0xff4422, // overcharge red-orange
};

// Per-kind diegetic shapes — real objects that tumble and settle like the
// gem does, identity carried by silhouette: a med capsule, an armor plate,
// an energy cell, a dog tag, a caged power core. Each returns a dark
// gunmetal BODY plus a thin ACCENT part that takes the kind's emissive
// color, so the tint becomes trim lighting rather than a full-body dye.
export interface PickupParts { body: THREE.BufferGeometry; accent: THREE.BufferGeometry; bodyColor?: number }

const _parts = new Map<PickupKind, PickupParts | null>();

export function pickupParts(kind: PickupKind): PickupParts | null {
  const hit = _parts.get(kind);
  if (hit !== undefined) return hit;
  const built = buildParts(kind);
  _parts.set(kind, built);
  return built;
}

function buildParts(kind: PickupKind): PickupParts | null {
  switch (kind) {
    case 'heal': {
      // Medical capsule — fat pill with a pale band around the waist.
      const body = mergeGeometries([
        new THREE.CapsuleGeometry(0.16, 0.34, 4, 10),
      ], false)!;
      const band = new THREE.TorusGeometry(0.17, 0.035, 6, 14);
      band.rotateX(Math.PI / 2);
      return { body, accent: band, bodyColor: 0xcfcfc4 };
    }
    case 'armor': {
      // Hexagonal armor plate standing on an edge — a chunk of plating.
      const plate = new THREE.CylinderGeometry(0.3, 0.3, 0.12, 6);
      plate.rotateX(Math.PI / 2);
      const rim = new THREE.TorusGeometry(0.26, 0.04, 4, 6);
      rim.rotateZ(Math.PI / 6); // flat side up like the hex
      return { body: plate, accent: rim };
    }
    case 'regen': {
      // Energy cell — short canister with glowing end-caps.
      const can = mergeGeometries([
        new THREE.CylinderGeometry(0.14, 0.14, 0.42, 10),
      ], false)!;
      const capA = new THREE.TorusGeometry(0.15, 0.03, 6, 12);
      capA.rotateX(Math.PI / 2);
      capA.translate(0, 0.17, 0);
      const capB = capA.clone();
      capB.translate(0, -0.34, 0);
      return { body: can, accent: mergeGeometries([capA, capB], false)! };
    }
    case 'tag': {
      // Dog-tag plate — flattened rounded box with a chain hole ring.
      const plate = mergeGeometries([
        new THREE.BoxGeometry(0.36, 0.05, 0.22),
      ], false)!;
      const ring = new THREE.TorusGeometry(0.05, 0.02, 6, 10);
      ring.rotateX(Math.PI / 2);
      ring.translate(0, 0.02, -0.07);
      const stripe = new THREE.BoxGeometry(0.3, 0.056, 0.03);
      stripe.translate(0, 0, 0.05);
      return { body: plate, accent: mergeGeometries([ring, stripe], false)! };
    }
    case 'dd': {
      // Power core — emissive nucleus held in an open cubic frame.
      // 12 thin box rods, one per cube edge, oriented along that edge's
      // axis so the cage merges as a solid mesh.
      const rods: THREE.BufferGeometry[] = [];
      const L = 0.36, T = 0.04, H = L / 2;
      for (const a of [-H, H]) for (const b of [-H, H]) {
        const rx = new THREE.BoxGeometry(L, T, T); rx.translate(0, a, b); rods.push(rx);
        const ry = new THREE.BoxGeometry(T, L, T); ry.translate(a, 0, b); rods.push(ry);
        const rz = new THREE.BoxGeometry(T, T, L); rz.translate(a, b, 0); rods.push(rz);
      }
      const core = new THREE.IcosahedronGeometry(0.14, 1);
      return { body: mergeGeometries(rods, false)!, accent: core };
    }
    default:
      return null; // gem/tag-less kinds keep the plain nugget gem
  }
}

/** Kind-tinted collect burst — rising sparks in the pickup's accent. */
export function pickupBurst(pos: THREE.Vector3, kind: PickupKind): void {
  const c = new THREE.Color(PICKUP_ACCENT[kind]);
  blastBurst(pos, {
    count: 22, elvBase: 0.15, elvSpan: Math.PI / 2,
    spdMin: 3, spdMax: 8, vy: 2.5,
    lifeMin: 0.35, lifeMax: 0.7, sizeMin: 0.1, sizeMax: 0.22,
    gravity: -4,
    c1: [c.r, c.g, c.b], c2: [1, 1, 1],
    opacity: 0.8, stagger: 0.08, spin: 4,
  }, true);
}
