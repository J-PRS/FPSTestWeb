/**
 * Declarative match definition — a room named <X> looks for maps/<X>.json
 * next to the server and takes its mode + creature population from it.
 * Everything is optional; missing fields fall back to these defaults, so a
 * spec can override one knob without restating the rest.
 *
 * This is the seed of a real map format — spawn anchors, bases and
 * objectives land here next; the file already decides what a match IS.
 */

import type { TeamId } from './teams.ts';

export interface BallPopulation {
  /** solo population */
  base: number;
  /** extra per additional player */
  perPlayer: number;
  /** hard ceiling */
  max: number;
}

export interface MapSpec {
  /** Default mode when the host doesn't pick one. */
  mode?: string;
  /** Modes this map can host — map = geometry+spawns+bases, mode = the
   *  ruleset on top. ctf-capable maps carry bases; modes not listed here
   *  fall back to the map's own `mode` (the map wins). Absent = only
   *  `mode` is legal, preserving the old one-mode-per-map semantics. */
  modes?: string[];
  balls: BallPopulation;
  /** Spawn anchors — farthest-from-enemies pick among these. Absent = the
   *  server's default spawn ring. `r` makes the anchor a sphere: the pick
   *  scatters to a random point inside the radius (T2 SpawnSpheres are
   *  volumes — without it every spawn lands on the center). `w` is the
   *  sphere's authored selection weight. */
  spawns?: SpawnPoint[];
  /** Team-owned spawn spheres (T2 missions group SpawnSpheres under
   *  Team1/Team2). When present for a team, that side spawns only from
   *  its own spheres. */
  teamSpawns?: { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] };
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
  /** Heightmap filename under maps/ (e.g. "ravine.bin" or
   *  "t2/escalade/terrain.bin" — one subdir deep) — a different terrain
   *  for this room's BallSim. Absent = the server's default field. */
  terrain?: string;
  /** Baked terrain albedo under maps/ (e.g. "t2/escalade/albedo.png") —
   *  client-only dressing; the sims never read it. */
  terrainTex?: string;
  /** Skybox dir under maps/ containing px/nx/py/ny/pz/nz.png — replaces
   *  the procedural sky when set. Client-only. */
  sky?: string;
  /** Static structures — axis-aligned boxes the server echoes into
   *  gameState so every client builds the same base compounds/cover.
   *  `kind` selects the renderer; `pos` is the piece's center. */
  structures?: StructureSpec[];
  /** Placed interior meshes — converted .dif→.glb buildings. `file` is a
   *  bare basename resolved to maps/t2/dif/<name>.glb client-side; `pos` is
   *  already in our meters; `rot` is a raw T2 axis-angle [x,y,z,deg];
   *  `scale` is pre-squashed into our axes. */
  interiors?: InteriorSpec[];
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
  team?: TeamId;
}

export interface Vec3like { x: number; y: number; z: number }

/** Spawn anchor — a point, or a sphere volume when `r` > 0. */
export interface SpawnPoint extends Vec3like {
  /** Sphere radius in meters — spawn scatters inside it. */
  r?: number;
  /** Authored selection weight (T2 sphereWeight). */
  w?: number;
}

export interface InteriorSpec {
  file: string;
  pos: Vec3like;
  rot?: number[];   // T2 axis-angle [ax, ay, az, degrees]
  scale?: Vec3like;
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

  return {
    mode: parseMode((src as { mode?: unknown }).mode),
    modes: parseModes((src as { modes?: unknown }).modes),
    balls,
    spawns: parseSpawns((src as { spawns?: unknown }).spawns),
    teamSpawns: parseTeamSpawns((src as { teamSpawns?: unknown }).teamSpawns),
    bases: parseBases((src as { bases?: unknown }).bases),
    bots: clampInt((src as { bots?: unknown }).bots, 0, 16, 0) || undefined,
    botFill: clampInt((src as { botFill?: unknown }).botFill, 0, 24, 0) || undefined,
    ballMix: parseBallMix((src as { ballMix?: unknown }).ballMix),
    // filename-only — the value is resolved under maps/ server-side, so
    // anything with a slash or dot-traversal is dropped on the floor
    terrain: parseTerrain((src as { terrain?: unknown }).terrain),
    terrainTex: parsePathField((src as { terrainTex?: unknown }).terrainTex, /\.(?:png|jpe?g)$/),
    sky: parsePathField((src as { sky?: unknown }).sky, /[\w-]{1,64}$/),
    structures: parseStructures((src as { structures?: unknown }).structures),
    interiors: parseInteriors((src as { interiors?: unknown }).interiors),
    arena: parseArena((src as { arena?: unknown }).arena),
    ambient: parseAmbient((src as { ambient?: unknown }).ambient),
    creatures: parseAmbient((src as { creatures?: unknown }).creatures),
  };
}

function parseMode(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[\w-]{1,32}$/.test(raw) ? raw : undefined;
}

function parseModes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((m): m is string => parseMode(m) !== undefined).slice(0, 8);
  return out.length ? out : undefined;
}

/** Modes a spec can legally host: the declared list, else its own mode,
 *  else anything (a mode-less spec is a bare arena). */
export function specModes(spec: MapSpec | undefined): string[] {
  return spec?.modes ?? (spec?.mode ? [spec.mode] : []);
}

function parseTerrain(raw: unknown): string | undefined {
  return parsePathField(raw, /\.bin$/); // t2/<map>/terrain.bin is 2 deep
}

/** maps/-relative path — word-char dirs, filename must carry the
 *  extension `tail` requires. No dots in segments => no traversal. */
function parsePathField(raw: unknown, tail: RegExp, maxDepth = 2): string | undefined {
  if (typeof raw !== 'string' || raw.length > 128) return undefined;
  const parts = raw.split('/');
  if (parts.length > maxDepth + 1) return undefined;
  for (const p of parts.slice(0, -1)) {
    if (!/^[\w-]{1,64}$/.test(p)) return undefined;   // dirs: word chars only, no dots
  }
  if (!/^[\w-]{1,64}(\.[\w-]{1,8})?$/.test(parts[parts.length - 1]!)) return undefined;
  return tail.test(raw) ? raw : undefined;
}

function parseSpawns(raw: unknown): SpawnPoint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SpawnPoint[] = [];
  for (const s of raw) {
    if (!isVec(s)) continue;
    const o = s as { r?: unknown; w?: unknown };
    out.push({
      x: s.x, y: s.y, z: s.z,
      r: typeof o.r === 'number' && Number.isFinite(o.r) ? Math.max(0, Math.min(400, o.r)) : undefined,
      w: typeof o.w === 'number' && Number.isFinite(o.w) && o.w > 0 ? Math.min(1000, o.w) : undefined,
    });
    if (out.length >= 32) break;
  }
  return out.length ? out : undefined;
}

function parseTeamSpawns(raw: unknown): MapSpec['teamSpawns'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const t = raw as { alpha?: unknown; bravo?: unknown };
  const alpha = parseSpawns(t.alpha);
  const bravo = parseSpawns(t.bravo);
  return alpha || bravo ? { alpha, bravo } : undefined;
}

function parseBases(raw: unknown): MapSpec['bases'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as { alpha?: unknown; bravo?: unknown };
  const out: MapSpec['bases'] = {
    alpha: isVec(b.alpha) ? b.alpha : undefined,
    bravo: isVec(b.bravo) ? b.bravo : undefined,
  };
  return out.alpha || out.bravo ? out : undefined;
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
const isVec = (s: unknown): s is Vec3like =>
  !!s && typeof s === 'object' &&
  Number.isFinite((s as Vec3like).x) &&
  Number.isFinite((s as Vec3like).y) &&
  Number.isFinite((s as Vec3like).z);

/** Validated structure list — bad entries dropped, sane clamps, cap 256. */
function parseStructures(raw: unknown): StructureSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
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

/** Validated interior placements — bare .dif basenames only (client maps
 *  them to t2/dif/*.glb), sane-clamped transforms, cap 256. */
function parseInteriors(raw: unknown): InteriorSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: InteriorSpec[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const file = typeof o.file === 'string' && /^[\w-]{1,64}\.dif$/i.test(o.file)
      ? o.file.toLowerCase() : undefined;
    if (!file || !isVec(o.pos)) continue;
    const rot = Array.isArray(o.rot) && o.rot.length === 4
      && o.rot.every(v => typeof v === 'number' && Number.isFinite(v))
      ? o.rot as number[] : undefined;
    out.push({ file, pos: o.pos, rot, scale: isVec(o.scale) ? o.scale : undefined });
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
