import { structureColliders, type StructureCollider } from './ballSim.ts';
import { MOVEMENT_CONFIG, type MoveState as MS } from './movement.ts';
import type { StructureSpec } from './mapSpec.ts';

/**
 * Solid-structure layer — turns the renderer's cover boxes into real
 * collision the move sim shares on both ends: top faces are walkable
 * floors (getHeight raises to them), side faces push the capsule out
 * laterally (walls block, below a small step-up allowance), and box
 * undersides act as ceilings. Pure math over StructureCollider (the
 * same yaw-OBB set ball bounces use), so server shadow and client
 * prediction resolve the identical contact.
 */

const STEP_UP = 0.55;   // ledges under this step onto floors like stairs
const SKIN = 0.02;      // push-out separation so contacts don't chatter

/** Swept segment vs the structure set — earliest entry point of a ray
 *  (shell path, LOS probe) into any yaw-OBB, or null. Slab test per
 *  collider in its local frame; returns the world-space hit point. */
export function segSolidHit(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  cols: readonly StructureCollider[],
): { x: number; y: number; z: number; t: number } | null {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  let bestT = Infinity;
  for (const c of cols) {
    const ox = from.x - c.cx, oz = from.z - c.cz;
    // Broadphase — skip boxes the segment can't approach.
    const rr = Math.max(c.hx, c.hz) + Math.hypot(dx, dz) + 1;
    if (ox * ox + oz * oz > rr * rr && (dx * ox + dz * oz) >= 0) continue;
    // Local frame: rotate origin + direction into the box's yaw space.
    const lx = ox * c.cos + oz * c.sin;
    const lz = -ox * c.sin + oz * c.cos;
    const ldx = dx * c.cos + dz * c.sin;
    const ldz = -dx * c.sin + dz * c.cos;
    // Slab test on all three axes.
    let tmin = 0, tmax = 1;
    let ok = true;
    for (const [o, d, h] of [[lx, ldx, c.hx], [from.y - c.cy, dy, c.hy], [lz, ldz, c.hz]] as const) {
      if (Math.abs(d) < 1e-9) { if (Math.abs(o) > h) { ok = false; break; } continue; }
      let t0 = (-h - o) / d, t1 = (h - o) / d;
      if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
      tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
      if (tmin > tmax) { ok = false; break; }
    }
    if (!ok || tmin >= bestT) continue;
    bestT = tmin;
  }
  if (bestT === Infinity) return null;
  return { x: from.x + dx * bestT, y: from.y + dy * bestT, z: from.z + dz * bestT, t: bestT };
}

export class SolidWorld {
  constructor(readonly cols: readonly StructureCollider[]) {}
  static fromSpecs(list: readonly StructureSpec[] | undefined): SolidWorld {
    return new SolidWorld(structureColliders(list));
  }

  /** Highest structure top face under (x,z) within the footprint —
   *  -Infinity when no piece covers that point. */
  topAt(x: number, z: number): number {
    let top = -Infinity;
    for (const c of this.cols) {
      const dx = x - c.cx, dz = z - c.cz;
      if (Math.abs(dx) > c.hx + Math.abs(c.sin) * 2 + 1 && Math.abs(dz) > c.hz + Math.abs(c.cos) * 2 + 1) continue;
      const lx = dx * c.cos + dz * c.sin;
      const lz = -dx * c.sin + dz * c.cos;
      if (lx < -c.hx || lx > c.hx || lz < -c.hz || lz > c.hz) continue;
      const t = c.cy + c.hy;
      if (t > top) top = t;
    }
    return top;
  }

  /** Push a body capsule out of side faces horizontally and stop it
   *  under ceilings. pos.y is capsule TOP (feet = pos.y - playerHeight),
   *  matching MoveSim's convention. */
  resolveBody(s: MS): void {
    const r = 0.45;
    const feet = s.pos.y - MOVEMENT_CONFIG.playerHeight;
    for (const c of this.cols) {
      const dx = s.pos.x - c.cx, dz = s.pos.z - c.cz;
      const rr = Math.max(c.hx, c.hz) + r + 1;
      if (dx * dx + dz * dz > rr * rr) continue;
      const top = c.cy + c.hy, bot = c.cy - c.hy;
      if (feet >= top - STEP_UP) continue;          // floor candidate — ground clamp owns it
      if (s.pos.y <= bot || feet >= top) continue;   // entirely below or above

      const lx = dx * c.cos + dz * c.sin;
      const lz = -dx * c.sin + dz * c.cos;
      const px = c.hx + r - Math.abs(lx);
      const pz = c.hz + r - Math.abs(lz);
      if (px <= 0 || pz <= 0) continue;              // outside the padded footprint
      if (feet < bot && s.pos.y > bot) {
        // Head into the underside — ceiling: drop out, kill upward motion.
        if (s.pos.y - bot < top - s.pos.y) {
          s.pos.y = bot - SKIN;
          if (s.vel.y > 0) s.vel.y = 0;
          continue;
        }
      }
      let pushX: number, pushZ: number;
      if (px < pz) {                                  // least-penetration axis
        const dir = lx >= 0 ? 1 : -1;
        pushX = dir * px * c.cos;
        pushZ = dir * px * c.sin;
      } else {
        const dir = lz >= 0 ? 1 : -1;
        pushX = -dir * pz * c.sin;
        pushZ = dir * pz * c.cos;
      }
      s.pos.x += pushX + Math.sign(pushX) * SKIN;
      s.pos.z += pushZ + Math.sign(pushZ) * SKIN;
      // Kill velocity into the face — sliding along walls stays free.
      const nx = px < pz ? Math.sign(pushX) * c.cos : -Math.sign(pushZ) * c.sin;
      const nz = px < pz ? Math.sign(pushX) * c.sin : Math.sign(pushZ) * c.cos;
      const dot = s.vel.x * nx + s.vel.z * nz;
      if (dot < 0) { s.vel.x -= nx * dot; s.vel.z -= nz * dot; }
    }
  }
}

/** Blast LOS check shared by the server's damage funnel and the client's
 *  blast prediction: is the straight line blast→target chest blocked by a
 *  structure? A blast point sitting INSIDE a collider (shell popped at a
 *  wall face) reports t≈0 — step past those contacts rather than calling
 *  every same-side target occluded. */
export function blastOccluded(
  blastPos: { x: number; y: number; z: number },
  targetPos: { x: number; y: number; z: number },
  cols: readonly StructureCollider[],
): boolean {
  const to = { x: targetPos.x, y: targetPos.y + 1.0, z: targetPos.z };
  let sx = blastPos.x, sy = blastPos.y, sz = blastPos.z;
  for (let hop = 0; hop < 3; hop++) {
    const dx = to.x - sx, dy = to.y - sy, dz = to.z - sz;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return false;
    const hit = segSolidHit({ x: sx, y: sy, z: sz }, to, cols);
    if (!hit) return false;
    if (hit.t > 0.001) return true;
    const step = 0.4 / d;
    sx += dx * step; sy += dy * step; sz += dz * step;
  }
  return false;
}
