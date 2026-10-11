/**
 * angles — shortest-arc yaw interpolation shared by the live remote
 * interp and demo playback so both pick the same wrap convention.
 * A naive a+(b-a)*t swings the wrong way across ±π (a 10°→350° turn
 * reads as a full spin backwards).
 */

/** Shortest signed distance a→b in radians, in (-π, π]. */
export function wrapAngleDelta(delta: number): number {
  let d = delta;
  while (d > Math.PI) {d -= 2 * Math.PI;}
  while (d < -Math.PI) {d += 2 * Math.PI;}
  return d;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngleDelta(b - a) * t;
}
