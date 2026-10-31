/**
 * Shared projectile ballistics — the minimal swept-segment core both the
 * server sim and any offline/test harness run. The client renderer keeps
 * its own THREE-bound Projectile with meshes and trails; this file is the
 * physics truth: where the shell IS, not how it looks.
 *
 * Swept segments, not point sampling: at 250 m/s a chaingun slug crosses
 * a player capsule in ~6ms, well inside one 20Hz tick. Every collision
 * query takes the whole prev→new segment so nothing tunnels.
 */
import { hmHeight, hmNormal, type Heightfield } from './heightfield.ts';
import type { Vec3 } from './protocol.ts';

export interface SimProjectile {
  pos: Vec3;
  vel: Vec3;
  age: number;
}

/** Integrate one step: gravity on vel.y, then pos += vel*dt.
 *  Returns the start-of-step position for swept checks — `into` reuses
 *  a caller scratch (consumed synchronously, never retained). */
export function projStep(p: SimProjectile, dt: number, gravity: number, into?: Vec3): Vec3 {
  const from = into ?? { x: 0, y: 0, z: 0 };
  from.x = p.pos.x; from.y = p.pos.y; from.z = p.pos.z;
  p.vel.y += gravity * dt;
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  p.pos.z += p.vel.z * dt;
  p.age += dt;
  return from;
}

/** Closest approach of segment [a,b] to point c.
 *  Returns the distance, or Infinity when the segment never enters the
 *  combined radius (target radius + projectile body radius). */
export function segPointDist(a: Vec3, b: Vec3, c: Vec3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  const t = lenSq > 0
    ? Math.max(0, Math.min(1, (acx * abx + acy * aby + acz * abz) / lenSq))
    : 0;
  const dx = acx - abx * t, dy = acy - aby * t, dz = acz - abz * t;
  return (dx * dx + dy * dy + dz * dz) ** 0.5;
}

/** Closest approach of segment [a,b] to the VERTICAL capsule axis at
 *  (c.x, c.z) spanning [c.y-half, c.y+half]. The old midpoint-sphere
 *  test (dist-to-center <= radius+half) over-covers vertically: a shot
 *  ~1m over the helmet or under the feet still registered - a miss that
 *  hits, violating the shooter's WYSIWYG contract. Standard
 *  segment-segment closest point with the axis degenerated to {x,z}
 *  constant. */
export function segCapsuleDist(a: Vec3, b: Vec3, cx: number, cy0: number, cy1: number, cz: number): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  const L = Math.max(cy1 - cy0, 1e-9);
  // Axis P(s) = (cx, cy0 + sL, cz). d = a - P(0).
  const ex = a.x - cx, ey = a.y - cy0, ez = a.z - cz;
  const dDotB = abx * ex + aby * ey + abz * ez;
  // t = (s·L·aby - d·ab)/ab² and s·L = ey + aby·t; solve jointly, then
  // clamp t and re-derive s (the axis endpoint nearest Q(t)).
  const denom = ab2 - aby * aby;
  let t = ab2 > 1e-12
    ? (denom > 1e-12 ? (aby * ey - dDotB) / denom : -dDotB / ab2)
    : 0;
  t = Math.max(0, Math.min(1, t));
  const s = Math.max(0, Math.min(1, (ey + aby * t) / L));
  const px = a.x + abx * t - cx;
  const py = a.y + aby * t - (cy0 + s * L);
  const pz = a.z + abz * t - cz;
  return (px * px + py * py + pz * pz) ** 0.5;
}

/** Closest-approach parameter of segment [a,b] to point c — WHERE along
 *  the beam the near-miss happens. segPointDist says how close; this says
 *  when, which is what a ray discharge needs to order competing hits. */
export function segPointT(a: Vec3, b: Vec3, c: Vec3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq <= 0) {return 0;}
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  return Math.max(0, Math.min(1, (acx * abx + acy * aby + acz * abz) / lenSq));
}

/** Swept heightfield check: sub-step the segment so a steep shell can't
 *  skip a thin ridge between samples. Returns the first underground
 *  point, or null. SAMPLE_STEP stays under the smallest bodyRadius. */
const TERRAIN_SAMPLE_STEP = 0.4;
export function segFieldHit(a: Vec3, b: Vec3, field: Heightfield): Vec3 | null {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = (dx * dx + dy * dy + dz * dz) ** 0.5;
  const steps = Math.max(1, Math.ceil(len / TERRAIN_SAMPLE_STEP));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
    if (y <= hmHeight(field, x, z)) {return { x, y, z };}
  }
  return null;
}

const _bN: Vec3 = { x: 0, y: 1, z: 0 };
/** Terrain bounce for fuse bombs (grenade): reflect the shell on the
 *  heightfield normal and keep it live — the fuse is the only trigger.
 *  Hard impacts reflect with restitution; weak grazes (<2 m/s into the
 *  ground) just bleed the normal component and slide, matching the
 *  client's slide-vs-pop rule so the replica arc stays honest. */
export function bounceOffField(p: SimProjectile, field: Heightfield, radius: number, restitution = 0.45, friction = 0.75): void {
  hmNormal(field, p.pos.x, p.pos.z, _bN);
  const vn = p.vel.x * _bN.x + p.vel.y * _bN.y + p.vel.z * _bN.z;
  if (vn < -2) {
    const k = -(1 + restitution) * vn;
    p.vel.x = (p.vel.x + _bN.x * k) * friction;
    p.vel.y += _bN.y * k;
    p.vel.z = (p.vel.z + _bN.z * k) * friction;
  } else if (vn < 0) {
    p.vel.x -= _bN.x * vn; p.vel.y -= _bN.y * vn; p.vel.z -= _bN.z * vn;
  }
  // Sit the shell's center one radius above the surface so the next
  // swept step doesn't instantly re-detect the same contact.
  p.pos.y = hmHeight(field, p.pos.x, p.pos.z) + radius + 0.05;
}
