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
