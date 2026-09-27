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
}

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

  const spawns = Array.isArray((src as { spawns?: unknown }).spawns)
    ? (src as { spawns: unknown[] }).spawns
        .filter((s): s is { x: number; y: number; z: number } =>
          !!s && typeof s === 'object' &&
          Number.isFinite((s as { x: number }).x) &&
          Number.isFinite((s as { y: number }).y) &&
          Number.isFinite((s as { z: number }).z))
        .slice(0, 32)
    : undefined;

  return {
    mode: typeof src.mode === 'string' && /^[\w-]{1,32}$/.test(src.mode) ? src.mode : undefined,
    balls,
    spawns: spawns?.length ? spawns : undefined,
  };
}
