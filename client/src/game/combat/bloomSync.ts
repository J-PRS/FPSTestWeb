/** Bloom-seed self-heal at echo bind.
 *
 * The server draws its cone off a counter that ticks per unique claim
 * arrival - a claim it never received can't skew it (the CSGO
 * random_seed hole). The client predicts with its own per-pull counter;
 * a dropped claim skews the two until the next reclaim reseat - and the
 * join path is the only channel that carried the authority's count.
 *
 * The projectileCreated echo's velocity IS the server's drawn dir, so
 * the seq is recoverable at bind: scan the window around the predicted
 * draw for the seed whose cone angle matches the echoed dir, and solve
 * the implied cone magnitude back into the server's bloom counter.
 * No wire field - the echo already carries everything. */
import { jitter01, getWeaponStats, bloomGrow, type WeaponType } from '../../../../shared/weapons.js';
import { idSeed } from '../../../../shared/weaponTable.js';

const TAU = Math.PI * 2;

export interface BloomSolve {
  /** Server counter value that produced the echoed dir. */
  seq: number;
  /** Implied server bloom right after the claim (post-grow). */
  bloom: number;
  /** Residual cone-angle error of the match, degrees. */
  angleDeg: number;
}

/** Match statistics - surfaced on the Alt+Q dump via parity. */
export const bloomSyncStats = { probes: 0, resyncs: 0, misses: 0 };

interface V3 { x: number; y: number; z: number }

/** Recover the seq the server drew for one echoed bloom dir, by
 * scanning ±window around the client's predicted seq for the jitter
 * whose cone ANGLE matches. Returns null when no seed explains the dir
 * - a divergence that isn't a seed skew (wrong claim dir, stalled aim)
 * must never move the counter.
 *
 * Angle alone identifies the seq almost uniquely over ±32 uniform
 * draws (~0.1rad gate ⇒ ~3% collision odds per candidate); the solved
 * offset magnitude then implies the server's pre-grow bloom. */
export function solveBloomSeq(opts: {
  playerId: string;
  weaponType: WeaponType;
  /** Claimed RAW aim dir (pre-jitter) - the base of both cones. */
  baseDir: V3;
  /** Normalized dir recovered from the echoed velocity. */
  serverDir: V3;
  /** The seq this shell predicted with. */
  guessSeq: number;
  /** Scan radius around guessSeq. */
  window?: number;
}): BloomSolve | null {
  const st = getWeaponStats(opts.weaponType);
  const spreadBase = st.spreadBase ?? 0;
  const bloomMax = st.bloomMax ?? 0;
  const win = opts.window ?? 64;
  const d = opts.baseDir, s = opts.serverDir;
  // Tangent basis - the same right/up construction coneDir applies.
  let rx = -d.z, rz = d.x;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-8) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
  const ux = -rz * d.y, uy = rz * d.x - rx * d.z, uz = rx * d.y;
  // Echoed offset projected into the cone plane → its angle + magnitude.
  const sd = s.x * d.x + s.y * d.y + s.z * d.z;
  const px = s.x - d.x * sd, py = s.y - d.y * sd, pz = s.z - d.z * sd;
  const offsetMag = Math.hypot(px, py, pz);
  if (offsetMag < 1e-4) {return null;} // zero offset = radius≈0 echo, says nothing about seq
  const aServer = Math.atan2(px * ux + py * uy + pz * uz, px * rx + pz * rz);
  let bestSeq = -1, bestAbs = Infinity, bestRadius = 0;
  const lo = Math.max(0, opts.guessSeq - win);
  for (let seq = lo; seq <= opts.guessSeq + win; seq += 1) {
    const [u1, u2] = jitter01(idSeed(opts.playerId) ^ seq);
    const rSqrt = Math.sqrt(u2);
    if (rSqrt < 1e-3) {continue;} // implied radius can't be solved
    const radius = offsetMag / rSqrt;
    // Plausibility: server radius is spreadBase + bloom ≤ spreadBase +
    // bloomMax (≈5% slack for the cone renormalize shrink).
    if (radius > spreadBase + bloomMax + 0.05) {continue;}
    let da = aServer - u1 * TAU;
    da -= Math.round(da / TAU) * TAU;
    const abs = Math.abs(da);
    if (abs < bestAbs) { bestAbs = abs; bestSeq = seq; bestRadius = radius; }
  }
  // ~5.7° gate: a true seed is near-exact; wrong-window luck sits wide.
  if (bestSeq < 0 || bestAbs > 0.1) {return null;}
  const decayed = Math.max(0, Math.min(bloomMax, bestRadius - spreadBase));
  return { seq: bestSeq, bloom: bloomGrow(decayed, opts.weaponType), angleDeg: bestAbs * 180 / Math.PI };
}
