/** Tiny vector helpers shared by the bot-brain family — three files
 *  used to each carry a private copy. `BotVec` is the plain-record vec
 *  the brains already trade in (not THREE.Vector3 — shared sims can't
 *  touch client types). */
export interface BotVec { x: number; y: number; z: number }

export function dist3(a: BotVec, b: BotVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function distSq(a: BotVec, b: BotVec): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Horizontal reach — orbit/arrive checks treat altitude as "there",
 *  unlike distSq which would read a ledge gap as distance left. Takes
 *  the minimal shape so 2D records (steer memory) typecheck too. */
export function distSqXZ(a: Pick<BotVec, 'x' | 'z'>, b: Pick<BotVec, 'x' | 'z'>): number {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
}

/** Zero-guarded XZ normalize — {x,z} is zeroed on zero input (the old
 *  `|| 1` sites produced the same). Hand-rolled copies of this lived
 *  in five places across botDisposition/botEscape. */
export function dirXZ(dx: number, dz: number): { x: number; z: number } {
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}

/** Zero-guarded 3D normalize — guarded with ||1 so near-zero input
 *  still yields a unit vector (the old `||0.001` copies silently halved
 *  the direction on sub-millimeter separations). SimVec/BotVec
 *  compatible in spirit; call sites pass components. */
export function dir3(dx: number, dy: number, dz: number): { x: number; y: number; z: number } {
  const l = Math.hypot(dx, dy, dz) || 1;
  return { x: dx / l, y: dy / l, z: dz / l };
}
