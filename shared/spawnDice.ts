/**
 * spawnDice — the ball-family spawn draws, on their OWN stream.
 *
 * The verifier replays recorded Spawned events against this exact draw
 * sequence, so the draw order here IS the format: timer roll → variant
 * roll → ctor draws (color, ring angle/radius, vel tri-up-tri). Any
 * consumer added to this stream re-sequences every downstream spawn —
 * the stream belongs to spawn-path code only, never behavior/VFX.
 *
 * Kept off simRand deliberately: spread/bomblet/species draws interleave
 * invisibly between spawn events — a shared stream makes spawn parity
 * unverifiable without replaying the whole client. One stream per
 * recorded family is the tauntRand lesson applied to verification.
 *
 * Draw contract per classic spawn event:
 *   [1] timer reset (entities: nextBallSpawn = spawnRand() * 10)
 *   [2] ctor: colorIdx (variant 0 only), ang, ring, vel = tri,up,tri
 * A split child reuses the same ctor draw then adds [ang, up].
 */

import { botRand } from './botRand.ts';
import { dcos, dsin } from './dmath.ts';
import { lcg32 } from './simRand.ts';

export const SPAWN_SEED_XOR = 0xC0_FF_EE;

let stream: (() => number) | null = null;
export function spawnRngSeed(runSeed: number): void { stream = lcg32((runSeed ^ SPAWN_SEED_XOR) >>> 0); }
export function spawnRng(r: () => number): void { stream = r; }
export function spawnRand(): number { return (stream ?? botRand)(); }

export interface SpawnVec { x: number; y: number; z: number }

/** The ctor's dice in shared order — client and verifier must produce
 *  identical {colorIdx, off, vel} for the same stream position. */
export interface BallSpawnDraw {
  colorIdx: number;   // -1 for elite/heavy variants (their table pins color)
  offX: number;       // ring offset from spawn center — client adds player x/z
  offZ: number;
  vel: SpawnVec;
}

const VARIANT_SCALE = [1, 2, 3, 2.4] as const;

export function drawBallSpawn(rand: () => number, variant: 0 | 1 | 2 | 3, colorCount: number): BallSpawnDraw {
  // Draw order mirrors Ball's ctor exactly: color pick (v0 only) →
  // ring ang → ring radius → vel tri,up,tri. Changing order changes
  // every downstream draw — the format, not a detail.
  const colorIdx = variant === 0 ? Math.floor(rand() * colorCount) : -1;
  const ang = rand() * Math.PI * 2;
  const ring = 100 + rand() * 300;
  const k = 1 / VARIANT_SCALE[variant];
  const tri = (): number => (rand() + rand() - 1) * 32;
  const vel = { x: tri() * k, y: (32 + rand() * 32) * k, z: tri() * k };
  return { colorIdx, offX: dcos(ang) * ring, offZ: dsin(ang) * ring, vel };
}

/** Elite-split child scatter — drawn AFTER the child ctor's full draw
 *  set (the ctor consumes its draw before its pos gets overwritten). */
export function drawSplitVel(rand: () => number): SpawnVec {
  const a = rand() * Math.PI * 2;
  const up = 9 + rand() * 6;
  return { x: dcos(a) * 14, y: up, z: dsin(a) * 14 };
}

/** Ambient variant pick — non-classic pools only. */
export function drawVariant(rand: () => number): 0 | 1 | 2 | 3 {
  const r = rand();
  if (r < 0.08) {return 3;}
  if (r < 0.18) {return 2;}
  if (r < 0.38) {return 1;}
  return 0;
}
