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
  /** Bot-fill floor: keep at least this many total bodies in the room by
   *  spawning/retiring bots as humans come and go. Distinct from `bots`
   *  (a fixed spawn count) — fill reacts to joins and quits. */
  botFill?: number;
  /** Spawn weights per ball variant [common, mid, large, elite] — default
   *  [0.84, 0.07, 0.04, 0.05]. Lets a map go all-elite or fodder-only. */
  ballMix?: number[];
  /** Heightmap filename under maps/ (e.g. "ravine.bin") — a different
   *  terrain for this room's BallSim. Absent = the server's default field. */
  terrain?: string;
  /** Static structures — axis-aligned boxes the server echoes into
   *  gameState so every client builds the same base compounds/cover.
   *  `kind` selects the renderer; `pos` is the piece's center. */
  structures?: StructureSpec[];
  /** Arena boundary — a dome centered on {x,z} with this radius. Echoed to
   *  clients for the barrier render; server uses it for out-of-bounds
   *  checks (future: damage/skid-push on contact). */
  arena?: { x: number; z: number; radius: number };
  /** Ambient species population overrides — { crawler: 0 } silences a
   *  species, { overlord: 4 } makes a boss map. Keys are species names
   *  ('crawler','seeker','rakk','strifer','gnat',...); absent = defaults.
   *  These are client-side ambience — they don't deal damage or sync. */
  ambient?: Record<string, number>;
  /** Server-authoritative creature population — { crawler: 6 } spawns
   *  real, replicated, damage-dealing/killable melee species via
   *  CreatureSim (shared/creatureSim.ts). Distinct from `ambient` which
   *  is client-side dressing only. */
  creatures?: Record<string, number>;
}

export interface StructureSpec {
  kind: 'box' | 'wall' | 'pillar' | 'ramp';
  pos: Vec3like;
  size: Vec3like;
  /** Y-rotation in radians (ramps/boxes), default 0. */
  rotY?: number;
  /** Team tint — 'alpha'|'bravo' bases color differently, else neutral. */
  team?: 'alpha' | 'bravo';
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
    botFill: clampInt((src as { botFill?: unknown }).botFill, 0, 24, 0) || undefined,
    ballMix: parseBallMix((src as { ballMix?: unknown }).ballMix),
    // filename-only — the value is resolved under maps/ server-side, so
    // anything with a slash or dot-traversal is dropped on the floor
    terrain: typeof (src as { terrain?: unknown }).terrain === 'string'
        && /^[\w-]{1,64}\.bin$/.test((src as { terrain: string }).terrain)
      ? (src as { terrain: string }).terrain
      : undefined,
    structures: parseStructures((src as { structures?: unknown }).structures),
    arena: parseArena((src as { arena?: unknown }).arena),
    ambient: parseAmbient((src as { ambient?: unknown }).ambient),
    creatures: parseAmbient((src as { creatures?: unknown }).creatures),
  };
}

function parseAmbient(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[\w-]{1,24}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(0, Math.min(200, Math.floor(v)));
  }
  return Object.keys(out).length ? out : undefined;
}

function parseArena(raw: unknown): MapSpec['arena'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as { x?: unknown; z?: unknown; radius?: unknown };
  if (!Number.isFinite(a.x) || !Number.isFinite(a.z) || !Number.isFinite(a.radius)) return undefined;
  const radius = Math.max(10, Math.min(750, a.radius as number));
  return { x: a.x as number, z: a.z as number, radius };
}

const STRUCT_KINDS = new Set(['box', 'wall', 'pillar', 'ramp']);
/** Validated structure list — bad entries dropped, sane clamps, cap 256. */
function parseStructures(raw: unknown): StructureSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const isVec = (s: unknown): s is Vec3like =>
    !!s && typeof s === 'object' &&
    Number.isFinite((s as Vec3like).x) &&
    Number.isFinite((s as Vec3like).y) &&
    Number.isFinite((s as Vec3like).z);
  const out: StructureSpec[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (typeof o.kind !== 'string' || !STRUCT_KINDS.has(o.kind)) continue;
    if (!isVec(o.pos) || !isVec(o.size)) continue;
    const size = {
      x: Math.max(0.2, Math.min(120, o.size.x)),
      y: Math.max(0.2, Math.min(60, o.size.y)),
      z: Math.max(0.2, Math.min(120, o.size.z)),
    };
    const pos = {
      x: Math.max(-2000, Math.min(2000, o.pos.x)),
      y: Math.max(-100, Math.min(300, o.pos.y)),
      z: Math.max(-2000, Math.min(2000, o.pos.z)),
    };
    out.push({
      kind: o.kind as StructureSpec['kind'],
      pos, size,
      rotY: typeof o.rotY === 'number' && Number.isFinite(o.rotY) ? o.rotY : undefined,
      team: o.team === 'alpha' || o.team === 'bravo' ? o.team : undefined,
    });
    if (out.length >= 256) break;
  }
  return out.length ? out : undefined;
}

/** Four non-negative weights, normalized. Anything malformed → undefined
 *  (sim falls back to its built-in mix). */
function parseBallMix(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const w = raw.map((v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0));
  return w.some((v) => v > 0) ? w : undefined;
}
