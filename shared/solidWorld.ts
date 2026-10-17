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
    for (let i = 0; i < cols.length; i += 1) {
      const c = cols[i]!;
      // Rotated XZ extents: yaw spreads hx/hz across both axes.
      const ex = Math.abs(c.hx * c.cos) + Math.abs(c.hz * c.sin);
      const ez = Math.abs(c.hx * c.sin) + Math.abs(c.hz * c.cos);
      const x0 = Math.floor((c.cx - ex - 1) / cell), x1 = Math.floor((c.cx + ex + 1) / cell);
      const z0 = Math.floor((c.cz - ez - 1) / cell), z1 = Math.floor((c.cz + ez + 1) / cell);
      for (let x = x0; x <= x1; x += 1) {for (let z = z0; z <= z1; z += 1) {
        const key = x * 4096 + z;
        let list = this.cells.get(key);
        if (!list) {this.cells.set(key, list = []);}
        list.push(i);
      }}
    }
  }

  /** Colliders whose XZ footprint a `pad`-expanded segment could touch —
   *  deduplicated, appended to `out` (scratch-passed, no alloc). */
  querySegment(ax: number, az: number, bx: number, bz: number, pad: number, out: StructureCollider[]): void {
    this.queryId += 1;
    const id = this.queryId;
    const x0 = Math.floor((Math.min(ax, bx) - pad) / this.cell), x1 = Math.floor((Math.max(ax, bx) + pad) / this.cell);
    const z0 = Math.floor((Math.min(az, bz) - pad) / this.cell), z1 = Math.floor((Math.max(az, bz) + pad) / this.cell);
    for (let x = x0; x <= x1; x += 1) {for (let z = z0; z <= z1; z += 1) {
      const list = this.cells.get(x * 4096 + z);
      if (!list) {continue;}
      for (const i of list) {
        if (this.stamp[i] === id) {continue;}
        this.stamp[i] = id;
        out.push(this.cols[i]!);
      }
    }}
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

const STEP_UP = MOVEMENT_CONFIG.stepUp;
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
  /** Shooter/body team — gate shields with a matching passTeam are
   *  air to this segment. Callers without team context omit it and
   *  shields stay solid (balls, creatures, neutral LOS). */
  passTeam?: string,
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
    if (passTeam && c.passTeam === passTeam) {continue;}
    const ox = from.x - c.cx, oz = from.z - c.cz;
    // Broadphase — skip boxes the segment can't approach.
    const rr = Math.max(c.hx, c.hz) + Math.hypot(dx, dz) + 1;
    if (ox * ox + oz * oz > rr * rr && (dx * ox + dz * oz) >= 0) {continue;}
    if (c.dome) {
      // Ray vs hemisphere — quadratic around the base center; a root
      // only counts when the contact lands on the cap (above the
      // spring line), the plinth hull handles the volume below.
      const cy0 = c.cy - c.hy;
      const sx = from.x - c.cx, sy = from.y - cy0, sz = from.z - c.cz;
      const a = dx * dx + dy * dy + dz * dz;
      const bq = sx * dx + sy * dy + sz * dz;
      const cq = sx * sx + sy * sy + sz * sz - c.dome * c.dome;
      const disc = bq * bq - a * cq;
      if (a < 1e-9 || disc < 0) {continue;}
      let t = (-bq - Math.sqrt(disc)) / a;
      if (t < 0) {t = cq < 0 ? 0 : Infinity;} // start inside → contact at start
      if (t > 1 || t >= bestT) {continue;}
      if (from.y + dy * t < cy0 - 0.01) {continue;}             // below the cap
      bestT = t;
      continue;
    }
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
    if (!ok || tmin >= bestT) {continue;}
    bestT = tmin;
  }
  if (bestT === Infinity) {return null;}
  return { x: from.x + dx * bestT, y: from.y + dy * bestT, z: from.z + dz * bestT, t: bestT };
}

export class SolidWorld {
  private readonly index: ColliderIndex;
  private readonly cands: StructureCollider[] = [];
  /** Live dynamic colliders (planted deployables, base assets) — a
   *  caller-owned array mutated in place as gear comes and goes, so no
   *  rebuild of the static index is ever needed. Scanned linearly; the
   *  deployable census is small enough that a grid buys nothing. */
  dyn?: readonly StructureCollider[];
  constructor(readonly cols: readonly StructureCollider[], dyn?: readonly StructureCollider[]) {
    this.index = new ColliderIndex(cols);
    this.dyn = dyn;
  }
  static fromSpecs(list: readonly StructureSpec[] | undefined, dyn?: readonly StructureCollider[]): SolidWorld {
    return new SolidWorld(structureColliders(list), dyn);
  }

  /** Highest structure top face under (x,z) within the footprint —
   *  -Infinity when no piece covers that point. `maxTop` caps which
   *  tops count as floor: a body clamping ground can only claim faces
   *  within step reach of its feet, or walking under a tall box would
   *  snap it straight up through the deck. */
  topAt(x: number, z: number, maxTop = Infinity): number {
    const {cands} = this;
    cands.length = 0;
    this.index.queryPoint(x, z, 2, cands);
    let top = -Infinity;
    for (const c of cands) {
      const dx = x - c.cx, dz = z - c.cz;
      if (Math.abs(dx) > c.hx + Math.abs(c.sin) * 2 + 1 && Math.abs(dz) > c.hz + Math.abs(c.cos) * 2 + 1) {continue;}
      if (c.dome) {
        // Walkable cap — closed-form dome height at the point; walking
        // up the curve is the ground clamp reading this top each step.
        const d2 = dx * dx + dz * dz;
        if (d2 < c.dome * c.dome) {
          const t = (c.cy - c.hy) + Math.sqrt(c.dome * c.dome - d2);
          if (t > top && t <= maxTop) {top = t;}
        }
        continue;
      }
      const lx = dx * c.cos + dz * c.sin;
      const lz = -dx * c.sin + dz * c.cos;
      if (lx < -c.hx || lx > c.hx || lz < -c.hz || lz > c.hz) {continue;}
      const t = c.cy + c.hy;
      if (t > top && t <= maxTop) {top = t;}
    }
    if (this.dyn) {for (const c of this.dyn) {
      // Axis-aligned only — deployable hulls never yaw.
      if (Math.abs(x - c.cx) > c.hx || Math.abs(z - c.cz) > c.hz) {continue;}
      const t = c.cy + c.hy;
      if (t > top && t <= maxTop) {top = t;}
    }}
    return top;
  }

  /** Push a body capsule out of side faces horizontally and stop it
   *  under ceilings. pos.y is the EYE point — feet sit `height` below it
   *  (per armor class), matching MoveSim's convention. `impact.v`
   *  accumulates the worst -v·n of every velocity kill — the caller's
   *  fall-damage meter (T1 charges wall slams, not just landings). */
  resolveBody(s: MS, height: number = MOVEMENT_CONFIG.playerHeight, impact?: { v: number }): void {
    const r = 0.45;
    const feet = s.pos.y - height;
    const {cands} = this;
    cands.length = 0;
    this.index.queryPoint(s.pos.x, s.pos.z, r + 1, cands);
    for (const c of cands) {
      // Gate shields pass their own team — the body walks the pane as
      // air while every other team hits it like a wall.
      if (c.passTeam && c.passTeam === s.team) {continue;}
      this.resolveOne(s, c, r, feet, impact);
    }
    if (this.dyn) {for (const c of this.dyn) {
      if (c.passTeam && c.passTeam === s.team) {continue;}
      this.resolveOne(s, c, r, feet, impact);
    }}
  }

  /** One collider vs the capsule: ceiling drop or least-penetration
   *  horizontal push + velocity kill into the face. */
  private resolveOne(s: MS, c: StructureCollider, r: number, feet: number, impact?: { v: number }): void {
    const dx = s.pos.x - c.cx, dz = s.pos.z - c.cz;
    const rr = Math.max(c.hx, c.hz) + r + 1;
    if (dx * dx + dz * dz > rr * rr) {return;}
    if (c.dome) {
      // Solid fill under the cap: anything with feet below the local
      // surface is inside the dome → shove radially to the rim. Feet at
      // the surface mean the ground clamp owns the contact (walking the
      // curve), same contract as box tops.
      const base = c.cy - c.hy;
      const d2 = dx * dx + dz * dz;
      const surf = d2 < c.dome * c.dome ? base + Math.sqrt(c.dome * c.dome - d2) : base;
      if (feet >= surf - STEP_UP || s.pos.y <= base - 0.01) {return;}
      const d = Math.sqrt(d2) || 1e-6;
      const push = c.dome + r - d;
      if (push <= 0) {return;}
      const nx = dx / d, nz = dz / d;
      s.pos.x += nx * (push + SKIN);
      s.pos.z += nz * (push + SKIN);
      const dot = s.vel.x * nx + s.vel.z * nz;
      if (dot < 0) { if (impact) {impact.v = Math.max(impact.v, -dot);} s.vel.x -= nx * dot; s.vel.z -= nz * dot; }
      return;
    }
    const top = c.cy + c.hy, bot = c.cy - c.hy;
    if (feet >= top - STEP_UP) {return;}          // floor candidate — ground clamp owns it
    if (s.pos.y <= bot || feet >= top) {return;}   // entirely below or above

    const lx = dx * c.cos + dz * c.sin;
    const lz = -dx * c.sin + dz * c.cos;
    const px = c.hx + r - Math.abs(lx);
    const pz = c.hz + r - Math.abs(lz);
    if (px <= 0 || pz <= 0) {return;}              // outside the padded footprint
    // Underside contact only when the bottom face is the LEAST-penetrated
    // axis: a flyer rising into a beam's belly drops back out. A walker
    // whose feet graze a hair below a grade-level box is a side contact —
    // the old head-vs-top compare dropped him below the wall entirely,
    // and the next floor clamp teleported him onto its top.
    if (feet < bot && s.pos.y > bot && s.pos.y - bot < Math.min(px, pz)) {
      s.pos.y = bot - SKIN;
      if (s.vel.y > 0) { if (impact) {impact.v = Math.max(impact.v, s.vel.y);} s.vel.y = 0; }
      return;
    }
    this.pushOut(s, c, lx, lz, px, pz, impact);
  }

  /** Least-penetration horizontal push out of a face, plus the velocity
   *  kill into it — sliding along walls stays free. */
  // oxlint-disable-next-line max-params -- the collision solve wants the resolved local frame, not a re-derived options bag
  private pushOut(s: MS, c: StructureCollider, lx: number, lz: number, px: number, pz: number, impact?: { v: number }): void {
    // oxlint-disable-next-line init-declarations -- both branches assign
    let pushX!: number, pushZ!: number;
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
    if (dot < 0) { if (impact) {impact.v = Math.max(impact.v, -dot);} s.vel.x -= nx * dot; s.vel.z -= nz * dot; }
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
  passTeam?: string,
): boolean {
  const to = { x: targetPos.x, y: targetPos.y + 1, z: targetPos.z };
  let sx = blastPos.x, sy = blastPos.y, sz = blastPos.z;
  for (let hop = 0; hop < 3; hop += 1) {
    const dx = to.x - sx, dy = to.y - sy, dz = to.z - sz;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) {return false;}
    const hit = segSolidHit({ x: sx, y: sy, z: sz }, to, cols, index, passTeam);
    if (!hit) {return false;}
    if (hit.t > 0.001) {return true;}
    const step = 0.4 / d;
    sx += dx * step; sy += dy * step; sz += dz * step;
  }
  return false;
}
