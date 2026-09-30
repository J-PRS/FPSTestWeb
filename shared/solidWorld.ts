import { structureColliders, type StructureCollider } from './ballSim.ts';
import { MOVEMENT_CONFIG, type MoveState as MS } from './movement.ts';
import type { StructureSpec } from './mapSpec.ts';

/** Uniform XZ grid over the static collider set — built once per map,
 *  queried every move-sim tick, projectile sweep, and blast occlusion.
 *  Each box registers into every cell its padded XZ AABB covers; queries
 *  visit cells in the segment's footprint and stamp visited boxes so a
 *  box spanning several cells is tested once. Prunes only — every test
 *  the linear scan would run still runs. */
export class ColliderIndex {
  private readonly cell: number;
  private readonly cells = new Map<number, number[]>();
  private readonly stamp: Int32Array;
  private queryId = 0;

  constructor(private readonly cols: readonly StructureCollider[], cell = 16) {
    this.cell = cell;
    this.stamp = new Int32Array(cols.length);
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]!;
      // Rotated XZ extents: yaw spreads hx/hz across both axes.
      const ex = Math.abs(c.hx * c.cos) + Math.abs(c.hz * c.sin);
      const ez = Math.abs(c.hx * c.sin) + Math.abs(c.hz * c.cos);
      const x0 = Math.floor((c.cx - ex - 1) / cell), x1 = Math.floor((c.cx + ex + 1) / cell);
      const z0 = Math.floor((c.cz - ez - 1) / cell), z1 = Math.floor((c.cz + ez + 1) / cell);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const key = x * 4096 + z;
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, list = []);
        list.push(i);
      }
    }
  }

  /** Colliders whose XZ footprint a `pad`-expanded segment could touch —
   *  deduplicated, appended to `out` (scratch-passed, no alloc). */
  querySegment(ax: number, az: number, bx: number, bz: number, pad: number, out: StructureCollider[]): void {
    const id = ++this.queryId;
    const x0 = Math.floor((Math.min(ax, bx) - pad) / this.cell), x1 = Math.floor((Math.max(ax, bx) + pad) / this.cell);
    const z0 = Math.floor((Math.min(az, bz) - pad) / this.cell), z1 = Math.floor((Math.max(az, bz) + pad) / this.cell);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const list = this.cells.get(x * 4096 + z);
      if (!list) continue;
      for (const i of list) {
        if (this.stamp[i] === id) continue;
        this.stamp[i] = id;
        out.push(this.cols[i]!);
      }
    }
  }

  queryPoint(x: number, z: number, pad: number, out: StructureCollider[]): void {
    this.querySegment(x, z, x, z, pad, out);
  }
}

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

const _segCands: StructureCollider[] = [];

/** Swept segment vs the structure set — earliest entry point of a ray
 *  (shell path, LOS probe) into any yaw-OBB, or null. Slab test per
 *  collider in its local frame; returns the world-space hit point. */
export function segSolidHit(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  cols: readonly StructureCollider[],
  index?: ColliderIndex,
): { x: number; y: number; z: number; t: number } | null {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const segLen = Math.hypot(dx, dz);
  let cands: readonly StructureCollider[] = cols;
  if (index) {
    _segCands.length = 0;
    index.querySegment(from.x, from.z, to.x, to.z, segLen + 2, _segCands);
    cands = _segCands;
  }
  let bestT = Infinity;
  for (const c of cands) {
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
  private readonly index: ColliderIndex;
  private readonly cands: StructureCollider[] = [];
  constructor(readonly cols: readonly StructureCollider[]) {
    this.index = new ColliderIndex(cols);
  }
  static fromSpecs(list: readonly StructureSpec[] | undefined): SolidWorld {
    return new SolidWorld(structureColliders(list));
  }

  /** Highest structure top face under (x,z) within the footprint —
   *  -Infinity when no piece covers that point. */
  topAt(x: number, z: number): number {
    const cands = this.cands;
    cands.length = 0;
    this.index.queryPoint(x, z, 2, cands);
    let top = -Infinity;
    for (const c of cands) {
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
    const cands = this.cands;
    cands.length = 0;
    this.index.queryPoint(s.pos.x, s.pos.z, r + 1, cands);
    for (const c of cands) this.resolveOne(s, c, r, feet);
  }

  /** One collider vs the capsule: ceiling drop or least-penetration
   *  horizontal push + velocity kill into the face. */
  private resolveOne(s: MS, c: StructureCollider, r: number, feet: number): void {
    const dx = s.pos.x - c.cx, dz = s.pos.z - c.cz;
    const rr = Math.max(c.hx, c.hz) + r + 1;
    if (dx * dx + dz * dz > rr * rr) return;
    const top = c.cy + c.hy, bot = c.cy - c.hy;
    if (feet >= top - STEP_UP) return;          // floor candidate — ground clamp owns it
    if (s.pos.y <= bot || feet >= top) return;   // entirely below or above

    const lx = dx * c.cos + dz * c.sin;
    const lz = -dx * c.sin + dz * c.cos;
    const px = c.hx + r - Math.abs(lx);
    const pz = c.hz + r - Math.abs(lz);
    if (px <= 0 || pz <= 0) return;              // outside the padded footprint
    if (feet < bot && s.pos.y > bot) {
      // Head into the underside — ceiling: drop out, kill upward motion.
      if (s.pos.y - bot < top - s.pos.y) {
        s.pos.y = bot - SKIN;
        if (s.vel.y > 0) s.vel.y = 0;
        return;
      }
    }
    this.pushOut(s, c, lx, lz, px, pz);
  }

  /** Least-penetration horizontal push out of a face, plus the velocity
   *  kill into it — sliding along walls stays free. */
  private pushOut(s: MS, c: StructureCollider, lx: number, lz: number, px: number, pz: number): void {
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

/** Blast LOS check shared by the server's damage funnel and the client's
 *  blast prediction: is the straight line blast→target chest blocked by a
 *  structure? A blast point sitting INSIDE a collider (shell popped at a
 *  wall face) reports t≈0 — step past those contacts rather than calling
 *  every same-side target occluded. */
export function blastOccluded(
  blastPos: { x: number; y: number; z: number },
  targetPos: { x: number; y: number; z: number },
  cols: readonly StructureCollider[],
  index?: ColliderIndex,
): boolean {
  const to = { x: targetPos.x, y: targetPos.y + 1.0, z: targetPos.z };
  let sx = blastPos.x, sy = blastPos.y, sz = blastPos.z;
  for (let hop = 0; hop < 3; hop++) {
    const dx = to.x - sx, dy = to.y - sy, dz = to.z - sz;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return false;
    const hit = segSolidHit({ x: sx, y: sy, z: sz }, to, cols, index);
    if (!hit) return false;
    if (hit.t > 0.001) return true;
    const step = 0.4 / d;
    sx += dx * step; sy += dy * step; sz += dz * step;
  }
  return false;
}
