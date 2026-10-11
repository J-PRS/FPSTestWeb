/**
 * ballCollide — sphere-vs-structure contact for SimBall: yaw-OBB
 * colliders precomputed from StructureSpec plus the push-out/reflect
 * solver. Deterministic and RNG-free so predictors replay the identical
 * bounce; kept apart from ballSim's forces/state so each concern reads
 * on its own.
 */
import type { StructureSpec } from './mapSpec.js';
import { KIT_HULLS } from './structKits.js';
import type { SimBall } from './ballSim.js';

/** Restitution for structure + body bounces. Lives here (not ballSim) so
 *  the collide helpers don't value-import the sim — one-directional dep. */
export const BALL_BOUNCE = 1;             // elastic reflection

/** Yaw-only oriented box for sphere-vs-structure contact. Precomputed from
 *  StructureSpec — pos is the piece's BASE center, so the box center sits
 *  at pos.y + size.y/2 (matches the client mesh). */
export interface StructureCollider {
  cx: number; cy: number; cz: number;
  hx: number; hy: number; hz: number;
  cos: number; sin: number;
  /** Hemisphere radius — when set the shape is a dome whose spring line
   *  sits at the bounding box's bottom (cy−hy): surface y(x,z) =
   *  base + sqrt(r² − d²). Box fields stay the bounding box so
   *  broadphase/index/layout lint need no shape awareness. */
  dome?: number;
  /** Team-gated shield pane: bodies/segments from this team pass
   *  through (gate shields). Undefined = solid for everyone. */
  passTeam?: string;
}

export function structureColliders(list: readonly StructureSpec[] | undefined): StructureCollider[] {
  if (!list?.length) {return [];}
  const out: StructureCollider[] = [];
  for (const s of list) {
    const cos = Math.cos(s.rotY ?? 0), sin = Math.sin(s.rotY ?? 0);
    if (s.kind === 'kit') {
      // Kit pieces collide as their authored hull set (local-space boxes,
      // folded by the piece's own rotY then the spec's) — the visual and
      // the collision are the same table, so a builder tweak that forgets
      // to update KIT_HULLS is the only drift risk left. `scale` is the
      // piece's uniform world scale: hull centers AND extents multiply.
      const k = s.scale ?? 1;
      for (const h of KIT_HULLS[s.piece ?? ''] ?? []) {
        const r = s.rotY ?? 0;
        out.push({
          cx: s.pos.x + (h.pos.x * k) * cos + (h.pos.z * k) * sin,
          cy: s.pos.y + h.pos.y * k,
          cz: s.pos.z - (h.pos.x * k) * sin + (h.pos.z * k) * cos,
          hx: h.size.x / 2 * k, hy: h.size.y / 2 * k, hz: h.size.z / 2 * k,
          cos: Math.cos(r + (h.rotY ?? 0)), sin: Math.sin(r + (h.rotY ?? 0)),
          dome: h.dome ? h.dome * k : undefined,
        });
      }
      continue;
    }
    if (s.kind === 'root') {
      // Arch collides as its two feet — the span overhead stays open to
      // ski under; a single OBB would wall off the whole gap.
      for (const sgn of [-1, 1]) {
        const lx = sgn * s.size.x;
        out.push({
          cx: s.pos.x + lx * cos, cy: s.pos.y + s.size.x / 2, cz: s.pos.z + lx * sin,
          hx: s.size.y, hy: s.size.x / 2, hz: s.size.y,
          cos, sin,
        });
      }
      continue;
    }
    out.push({
      cx: s.pos.x, cy: s.pos.y + s.size.y / 2, cz: s.pos.z,
      hx: s.size.x / 2, hy: s.size.y / 2, hz: s.size.z / 2,
      cos, sin,
      passTeam: s.kind === 'shield' ? s.team : undefined,
    });
  }
  return out;
}

/** Authored-layout lint: which pairs of spec entries interpenetrate.
 *  Compares each entry's expanded collider set (kit hulls, not the
 *  placeholder size) as yaw-OBBs approximated by their XZ AABB + Y span.
 *  Per-entry self-overlap is ignored — compound folds pack tight by
 *  design — and a 'shield' pane inside its own gatehouse slot is the
 *  intended coincidence. `eps` is the skin depth that counts as
 *  touching, not intersecting. */
export function findStructureOverlaps(list: readonly StructureSpec[] | undefined, eps = 0.3): { a: number; b: number; x: number; y: number; z: number }[] {
  const out: { a: number; b: number; x: number; y: number; z: number }[] = [];
  if (!list?.length) {return out;}
  const perSpec = list.map((s) => structureColliders([s]));
  const gatePair = (i: number, j: number) =>
    (list[i]!.kind === 'shield' && list[j]!.kind === 'kit' && list[j]!.piece === 'gatehouse') ||
    (list[j]!.kind === 'shield' && list[i]!.kind === 'kit' && list[i]!.piece === 'gatehouse');
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (gatePair(i, j)) {continue;}
      // Butted joints are authored everywhere (wall T-junctions, hull
      // chains telescoping a few meters). The flag is *containment*:
      // the overlap swallowing a real fraction of the smaller box.
      // XZ is true 2D OBB SAT (project on all four face axes) — an
      // AABB approx inflates yawed pieces into phantom containment.
      let worst = 0;
      let best: { x: number; y: number; z: number } | null = null;
      for (const ca of perSpec[i]!) {for (const cb of perSpec[j]!) {
        const oy = Math.min(ca.cy + ca.hy, cb.cy + cb.hy) - Math.max(ca.cy - ca.hy, cb.cy - cb.hy);
        if (oy <= eps) {continue;}
        const dx = cb.cx - ca.cx, dz = cb.cz - ca.cz;
        // Face axes of each box in world XZ: local x ↦ (cos,−sin), z ↦ (sin,cos).
        const proj = (c: StructureCollider, ax: number, az: number) =>
          c.hx * Math.abs(c.cos * ax - c.sin * az) + c.hz * Math.abs(c.sin * ax + c.cos * az);
        const axes = [
          [ca.cos, -ca.sin, ca.hx, proj(cb, ca.cos, -ca.sin)],
          [ca.sin, ca.cos, ca.hz, proj(cb, ca.sin, ca.cos)],
          [cb.cos, -cb.sin, cb.hx, proj(ca, cb.cos, -cb.sin)],
          [cb.sin, cb.cos, cb.hz, proj(ca, cb.sin, cb.cos)],
        ] as const;
        let d0 = Infinity, d1 = Infinity;
        for (const [ax, az, ra, rb] of axes) {
          const dep = ra + rb - Math.abs(dx * ax + dz * az);
          if (dep <= eps) { d1 = 0; d0 = d1; break; }
          if (dep < d0) { d1 = d0; d0 = dep; } else if (dep < d1) {d1 = dep;}
        }
        if (d0 <= eps) {continue;}
        // The two shallowest SAT depths bound the intersection footprint.
        const va = 8 * ca.hx * ca.hy * ca.hz, vb = 8 * cb.hx * cb.hy * cb.hz;
        const frac = (d0 * d1 * oy) / Math.min(va, vb);
        if (frac > worst) { worst = frac; best = { x: d0, y: oy, z: d1 }; }
      }}
      if (best && worst > 0.35) {out.push(Object.assign({}, {a: i,b: j}, best));}
    }
  }
  return out;
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
    if (dx * dx + dz * dz > rr * rr) {continue;}
    if (c.dome) {
      // Sphere vs hemisphere: contact normal runs from the dome's base
      // center to the ball — the buried half never matters, the plinth
      // hull owns the volume below the spring line.
      const cy0 = c.cy - c.hy;
      const sx = b.x - c.cx, sy = b.y - cy0, sz = b.z - c.cz;
      const d2 = sx * sx + sy * sy + sz * sz;
      const reach = c.dome + b.radius;
      if (d2 >= reach * reach) {continue;}
      const d = Math.sqrt(d2) || 1;
      const push = reach - d;
      b.x += (sx / d) * push; b.y += (sy / d) * push; b.z += (sz / d) * push;
      const dot = (b.vx * sx + b.vy * sy + b.vz * sz) / d;
      if (dot < 0) {
        const k = -(1 + BALL_BOUNCE) * dot / d;
        b.vx += sx * k; b.vy += sy * k; b.vz += sz * k;
      }
      return true;
    }
    // into local yaw frame
    const lx = dx * c.cos + dz * c.sin;
    const lz = -dx * c.sin + dz * c.cos;
    const qx = Math.max(-c.hx, Math.min(c.hx, lx));
    const qy = Math.max(-c.hy, Math.min(c.hy, dy));
    const qz = Math.max(-c.hz, Math.min(c.hz, lz));
    let nx = lx - qx, ny = dy - qy, nz = lz - qz;
    const d2 = nx * nx + ny * ny + nz * nz;
    if (d2 >= b.radius * b.radius) {continue;}
    // oxlint-disable-next-line init-declarations -- assigned later
    let d!: number;
    if (d2 > 1e-9) {
      d = Math.sqrt(d2);
      nx /= d; ny /= d; nz /= d;
    } else {
      // center inside the box — exit along the axis of least depth
      const px = c.hx - Math.abs(lx), py = c.hy - Math.abs(dy), pz = c.hz - Math.abs(lz);
      nx = 0; ny = 0; nz = 0;
      if (px <= py && px <= pz) {nx = Math.sign(lx) || 1;}
      else if (py <= pz) {ny = Math.sign(dy) || 1;}
      else {nz = Math.sign(lz) || 1;}
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
