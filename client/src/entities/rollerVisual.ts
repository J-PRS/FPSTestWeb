/**
 * rollerVisual — Roller's render surface: the shared faceted-boulder
 * geometry/material, the swarm part table, and the per-frame instance
 * write. Roller keeps movement + knockback; this file owns how a boulder
 * LOOKS — lumps, tint shade, hit flash, shadow blob.
 */
import * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';
import type { SwarmPart } from './swarm.js';
import { getSwarm, getShadows } from './swarms.js';

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

// Faceted boulder — vertex-jittered so the silhouette is lumpy rock, not a
// beach ball. Displacement is a position-hash: shared verts displace
// identically, so no cracks open, and every roller uses the same seed so
// the swarm instances stay identical.
let _geo: THREE.BufferGeometry | null = null;
function rollerGeo(): THREE.BufferGeometry {
  if (!_geo) {
    const g = new THREE.IcosahedronGeometry(1, 2);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      const n = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719) * 43758.5453;
      const j = 0.8 + (n - Math.floor(n)) * 0.4; // 0.8..1.2 radial bulge
      v.multiplyScalar(j);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals(); // re-light after the deform — lumps get shading
    _geo = g;
  }
  return _geo;
}

let _mat: THREE.MeshLambertMaterial | null = null;

/** Swarm part table — one rigid boulder per roller. */
export function rollerParts(): SwarmPart[] {
  if (!_mat) _mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  return [{ geometry: rollerGeo(), material: _mat, castShadow: true }];
}

/** Flat-field bag the writer reads — the entity publishes these. */
export interface RollerVisHost {
  hasSlots: boolean;
  swarmSlot: number;
  pos: THREE.Vector3;
  radius: number;
  color: THREE.Color;
  rollQuat: THREE.Quaternion;
  tint: number;
  flash: number;
}

export function writeRollerInstances(r: RollerVisHost, _terrain?: Terrain): void {
  if (!r.hasSlots) return;
  const swarm = getSwarm('roller');
  if (swarm) {
    _s.setScalar(r.radius);
    _m.compose(r.pos, r.rollQuat, _s);
    swarm.setMatrix(0, r.swarmSlot, _m);
    const fr = r.flash > 0 ? 4 : 1;
    swarm.setColor(0, r.swarmSlot, r.color.r * fr * r.tint, r.color.g * fr * r.tint, r.color.b * fr * r.tint);
  }
  getShadows()?.set(r as never, r.pos, r.radius * 1.05, 0.4);
}
