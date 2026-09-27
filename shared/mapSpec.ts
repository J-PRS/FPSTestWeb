/**
 * Declarative match definition — a room named <X> looks for maps/<X>.json
 * next to the server and takes its mode + creature population from it.
 * Everything is optional; missing fields fall back to these defaults, so a
 * spec can override one knob without restating the rest.
 *
 * This is the seed of a real map format — spawn anchors, bases and
 * objectives land here next; the file already decides what a match IS.
 */

export interface BallPopulation {
  /** solo population */
  base: number;
  /** extra per additional player */
  perPlayer: number;
  /** hard ceiling */
  max: number;
}

export interface MapSpec {
  mode?: string;
  balls: BallPopulation;
  /** Spawn anchors — farthest-from-enemies pick among these. Absent = the
   *  server's default spawn ring. */
  spawns?: { x: number; y: number; z: number }[];
  /** Objective anchors per team — flag stands, capture rings, generators.
   *  Generic positions the mode interprets (ctf: flag stands). */
  bases?: { alpha?: Vec3like; bravo?: Vec3like };
  /** Server-driven filler players — wandering, shootable, team-balanced. */
  bots?: number;
  /** Spawn weights per ball variant [common, mid, large, elite] — default
   *  [0.84, 0.07, 0.04, 0.05]. Lets a map go all-elite or fodder-only. */
  ballMix?: number[];
}

export interface Vec3like { x: number; y: number; z: number }

export const DEFAULT_MAP_SPEC: MapSpec = {
  balls: { base: 10, perPlayer: 4, max: 40 },
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(lo, Math.min(hi, Math.floor(v)))
    : fallback;

/** Merge a parsed JSON blob over the defaults — never trusts the file. */
export function resolveMapSpec(raw: unknown): MapSpec {
  const src = (raw && typeof raw === 'object' ? raw : {}) as {
    mode?: unknown;
    balls?: { base?: unknown; perPlayer?: unknown; max?: unknown };
  };
  const d = DEFAULT_MAP_SPEC.balls;
  const balls: BallPopulation = {
    base: clampInt(src.balls?.base, 0, 200, d.base),
    perPlayer: clampInt(src.balls?.perPlayer, 0, 50, d.perPlayer),
    max: clampInt(src.balls?.max, 0, 200, d.max),
  };
  if (balls.max < balls.base) balls.max = balls.base;

  const isVec = (s: unknown): s is Vec3like =>
    !!s && typeof s === 'object' &&
    Number.isFinite((s as Vec3like).x) &&
    Number.isFinite((s as Vec3like).y) &&
    Number.isFinite((s as Vec3like).z);

  const spawns = Array.isArray((src as { spawns?: unknown }).spawns)
    ? (src as { spawns: unknown[] }).spawns.filter(isVec).slice(0, 32)
    : undefined;

  const rawBases = (src as { bases?: unknown }).bases;
  const bases = rawBases && typeof rawBases === 'object'
    ? {
        alpha: isVec((rawBases as { alpha?: unknown }).alpha) ? (rawBases as { alpha: Vec3like }).alpha : undefined,
        bravo: isVec((rawBases as { bravo?: unknown }).bravo) ? (rawBases as { bravo: Vec3like }).bravo : undefined,
      }
    : undefined;

  return {
    mode: typeof src.mode === 'string' && /^[\w-]{1,32}$/.test(src.mode) ? src.mode : undefined,
    balls,
    spawns: spawns?.length ? spawns : undefined,
    bases: bases && (bases.alpha || bases.bravo) ? bases : undefined,
    bots: clampInt((src as { bots?: unknown }).bots, 0, 16, 0) || undefined,
    ballMix: parseBallMix((src as { ballMix?: unknown }).ballMix),
  };
}

/** Four non-negative weights, normalized. Anything malformed → undefined
 *  (sim falls back to its built-in mix). */
function parseBallMix(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const w = raw.map((v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0));
  return w.some((v) => v > 0) ? w : undefined;
}
