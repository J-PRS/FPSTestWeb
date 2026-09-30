/**
 * ballCollide — sphere-vs-structure contact for SimBall: yaw-OBB
 * colliders precomputed from StructureSpec plus the push-out/reflect
 * solver. Deterministic and RNG-free so predictors replay the identical
 * bounce; kept apart from ballSim's forces/state so each concern reads
 * on its own.
 */
import type { StructureSpec } from './mapSpec.js';
import { BALL_BOUNCE } from './ballSim.js';
import type { SimBall } from './ballSim.js';

/** Yaw-only oriented box for sphere-vs-structure contact. Precomputed from
 *  StructureSpec — pos is the piece's BASE center, so the box center sits
 *  at pos.y + size.y/2 (matches the client mesh). */
export interface StructureCollider {
  cx: number; cy: number; cz: number;
  hx: number; hy: number; hz: number;
  cos: number; sin: number;
}

export function structureColliders(list: readonly StructureSpec[] | undefined): StructureCollider[] {
  if (!list?.length) return [];
  return list.map(s => ({
    cx: s.pos.x, cy: s.pos.y + s.size.y / 2, cz: s.pos.z,
    hx: s.size.x / 2, hy: s.size.y / 2, hz: s.size.z / 2,
    cos: Math.cos(s.rotY ?? 0), sin: Math.sin(s.rotY ?? 0),
  }));
}

const _cn = { x: 0, y: 0, z: 0 }; // scratch — contact normal
const _colCands: StructureCollider[] = [];

/** Sphere vs yaw-OBB: push the ball out along the least-penetration axis
 *  and reflect velocity off the contact normal. Returns true on contact. */
export function collideStructures(b: SimBall, colliders: readonly StructureCollider[], index?: { queryPoint(x: number, z: number, pad: number, out: StructureCollider[]): void }): boolean {
  let cands: readonly StructureCollider[] = colliders;
  if (index) { _colCands.length = 0; index.queryPoint(b.x, b.z, b.radius + 0.5, _colCands); cands = _colCands; }
  for (const c of cands) {
    const dx = b.x - c.cx, dy = b.y - c.cy, dz = b.z - c.cz;
    // cheap broadphase — skip pieces nowhere near this ball
    const rr = Math.max(c.hx, c.hz) + b.radius + 0.5;
    if (dx * dx + dz * dz > rr * rr) continue;
    // into local yaw frame
    const lx = dx * c.cos + dz * c.sin;
    const lz = -dx * c.sin + dz * c.cos;
    const qx = Math.max(-c.hx, Math.min(c.hx, lx));
    const qy = Math.max(-c.hy, Math.min(c.hy, dy));
    const qz = Math.max(-c.hz, Math.min(c.hz, lz));
    let nx = lx - qx, ny = dy - qy, nz = lz - qz;
    let d2 = nx * nx + ny * ny + nz * nz;
    if (d2 >= b.radius * b.radius) continue;
    let d: number;
    if (d2 > 1e-9) {
      d = Math.sqrt(d2);
      nx /= d; ny /= d; nz /= d;
    } else {
      // center inside the box — exit along the axis of least depth
      const px = c.hx - Math.abs(lx), py = c.hy - Math.abs(dy), pz = c.hz - Math.abs(lz);
      nx = 0; ny = 0; nz = 0;
      if (px <= py && px <= pz) nx = Math.sign(lx) || 1;
      else if (py <= pz) ny = Math.sign(dy) || 1;
      else nz = Math.sign(lz) || 1;
      d = -Math.min(px, py, pz); // negative = overlap depth
    }
    // normal back to world yaw frame
    _cn.x = nx * c.cos - nz * c.sin;
    _cn.y = ny;
    _cn.z = nx * c.sin + nz * c.cos;
    const push = b.radius - d;
    b.x += _cn.x * push; b.y += _cn.y * push; b.z += _cn.z * push;
    const dot = b.vx * _cn.x + b.vy * _cn.y + b.vz * _cn.z;
    if (dot < 0) {
      const k = -(1 + BALL_BOUNCE) * dot;
      b.vx += _cn.x * k; b.vy += _cn.y * k; b.vz += _cn.z * k;
    }
    return true;
  }
  return false;
}
