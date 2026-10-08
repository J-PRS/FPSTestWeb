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
import { KIT_HULLS } from './structKits.js';

export interface BallPopulation {
  /** solo population */
  base: number;
  /** extra per additional player */
  perPlayer: number;
  /** hard ceiling */
  max: number;
}

export interface MapSpec {
  /** Human title for HUD/chrome ("Dangerous Crossing"). Absent = the
   *  spec's filename, prettified client-side. */
  name?: string;
  /** Default mode when the host doesn't pick one. */
  mode?: string;
  /** Excluded from the menu map list but still joinable by name —
   *  test grounds and half-built maps live here. */
  hidden?: boolean;
  /** Modes this map can host — map = geometry+spawns+bases, mode = the
   *  ruleset on top. Absent = own `mode` + every self-provisioning
   *  ruleset (ctf additionally requires `bases`); declared = exact list,
   *  for maps that need to narrow the default. */
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
  /** Difficulty band for spawned bots — one tier for the whole lobby, or
   *  {alpha,bravo} to handicap sides differently. Per-bot variance rolls
   *  around the band, so a team's bots aren't clones. */
  botSkill?: import('./botSkill.ts').BotSkillSpec | { alpha?: import('./botSkill.ts').BotSkillSpec; bravo?: import('./botSkill.ts').BotSkillSpec };
  /** Spawn weights per ball variant [common, mid, large, elite] — default
   *  [0.84, 0.07, 0.04, 0.05]. Lets a map go all-elite or fodder-only. */
  ballMix?: number[];
  /** Heightmap filename under maps/ (e.g. "ravine.bin" or
   *  "t2/escalade/terrain.bin" — one subdir deep) — a different terrain
   *  for this room's BallSim. Absent = the server's default field. */
  terrain?: string;
  /** Vertical gain on the room's field — multiplies the base 125m scale
   *  (0.1–8). Applies to spec.terrain AND the default field alike; the
   *  value rides the wire so client prediction and render agree. */
  heightScale?: number;
  /** Meters one heightmap wrap covers (256–4096) — T2 ports carry their
   *  native 2048m tile so nothing on the map is squished horizontally.
   *  Absent = the engine default 1500. Rides the wire like heightScale. */
  tileSize?: number;
  /** Mission-authored haze (T2 Sky block): `color` is the fog tint
   *  [r,g,b], `distance` the fog start, `visible` where full fog
   *  swallows the world. Absent = engine default haze. Client-only. */
  fog?: { color: [number, number, number]; distance?: number; visible?: number };
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
  /** Authored base assets — live deployables (generator, turret, sensor,
   *  pad) the server seeds at room open instead of waiting for a plant.
   *  Destructible, repairable, and they respawn on a long fuse — the
   *  Tribes generator economy. `team` makes them faction-owned. */
  deploys?: DeploySpec[];
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
  /** Parse diagnostics — every input resolveMapSpec coerced, clamped, or
   *  dropped, collected at load. mapCatalog logs them so a typo'd field
   *  in a maps/*.json announces itself instead of silently defaulting. */
  warnings?: string[];
}

export interface DeploySpec {
  kind: import('./deployables.ts').DeployKind;
  pos: Vec3like;
  team?: import('./teams.ts').TeamId;
}

export interface StructureSpec {
  /** 'stand' collides like a box but the client's generic box renderer
   *  skips it — the visual is the real dais mesh; the spec is the hull. */
  /** 'hull' is collision-only like 'stand' — T2 interior convex-hull
   *  boxes emitted by the porter; the real mesh is the visual. */
  /** 'shield' is a team-gated energy pane: collides for everyone EXCEPT
   *  `team` — allies walk and shoot through, enemies hit a wall. The
   *  client renders it as a translucent barrier; a team-less shield is
   *  legal but pointless (blocks everyone, same as a wall). */
  kind: 'box' | 'wall' | 'pillar' | 'ramp' | 'root' | 'stand' | 'hull' | 'kit' | 'shield';
  /** 'kit' pieces render through the structKit builders and collide via
   *  KIT_HULLS (shared/structKits) — `size` is ignored for them. */
  piece?: string;
  /** 'kit' pieces: uniform world scale applied to the render AND the
   *  hull expansion — one knob, no parity seam. Default 1. */
  scale?: number;
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

// Parse-warning collector — resolveMapSpec opens the window, every
// parser pushes, the finished spec carries the list as `warnings`.
// A typo'd maps/*.json used to fall back or clamp SILENTLY (the flag
// base that snapped to a default, the bots: "8" string that dropped) —
// now every coerced/rejected input reports itself at load.
let parseWarnings: string[] | null = null;
const specWarn = (m: string): void => { parseWarnings?.push(m); };

const clampInt = (v: unknown, lo: number, hi: number, fallback: number, label: string): number => {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    specWarn(`${label}: non-numeric value dropped (${JSON.stringify(v)})`);
    return fallback;
  }
  const c = Math.max(lo, Math.min(hi, Math.floor(v)));
  if (c !== v) specWarn(`${label}: ${v} clamped to ${c} (${lo}..${hi})`);
  return c;
};

/** Merge a parsed JSON blob over the defaults — never trusts the file. */
/** Strict-JSON.parse wrapper that tolerates // and block comments —
 *  spec files are hand-authored, so inline notes are legitimate. The
 *  regex walks string literals intact, so only real comment tokens are
 *  stripped (a "//" inside a quoted value survives). Single chokepoint
 *  for server catalog, client solo fetch and tests. */
export function parseMapSpecJson(text: string): unknown {
  return JSON.parse(text.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m) => (m.startsWith('/') ? '' : m)));
}

export function resolveMapSpec(raw: unknown): MapSpec {
  const src = (raw && typeof raw === 'object' ? raw : {}) as {
    mode?: unknown;
    balls?: { base?: unknown; perPlayer?: unknown; max?: unknown };
  };
  parseWarnings = [];
  const d = DEFAULT_MAP_SPEC.balls;
  const balls: BallPopulation = {
    base: clampInt(src.balls?.base, 0, 200, d.base, 'balls.base'),
    perPlayer: clampInt(src.balls?.perPlayer, 0, 50, d.perPlayer, 'balls.perPlayer'),
    max: clampInt(src.balls?.max, 0, 200, d.max, 'balls.max'),
  };
  if (balls.max < balls.base) balls.max = balls.base;

  const spec: MapSpec = {
    name: parseName((src as { name?: unknown }).name),
    mode: parseMode((src as { mode?: unknown }).mode),
    hidden: (src as { hidden?: unknown }).hidden === true ? true : undefined,
    modes: parseModes((src as { modes?: unknown }).modes),
    balls,
    spawns: parseSpawns((src as { spawns?: unknown }).spawns),
    teamSpawns: parseTeamSpawns((src as { teamSpawns?: unknown }).teamSpawns),
    bases: parseBases((src as { bases?: unknown }).bases),
    bots: clampInt((src as { bots?: unknown }).bots, 0, 16, 0, 'bots') || undefined,
    botFill: clampInt((src as { botFill?: unknown }).botFill, 0, 24, 0, 'botFill') || undefined,
    botSkill: parseBotSkill((src as { botSkill?: unknown }).botSkill),
    ballMix: parseBallMix((src as { ballMix?: unknown }).ballMix),
    // filename-only — the value is resolved under maps/ server-side, so
    // anything with a slash or dot-traversal is dropped on the floor
    terrain: parseTerrain((src as { terrain?: unknown }).terrain),
    heightScale: parseHeightScale((src as { heightScale?: unknown }).heightScale),
    tileSize: parseTileSize((src as { tileSize?: unknown }).tileSize),
    fog: parseFog((src as { fog?: unknown }).fog),
    terrainTex: parsePathField((src as { terrainTex?: unknown }).terrainTex, /\.(?:png|jpe?g|webp)$/, 2, 'terrainTex'),
    sky: parsePathField((src as { sky?: unknown }).sky, /[\w-]{1,64}$/, 2, 'sky'),
    structures: parseStructures((src as { structures?: unknown }).structures),
    deploys: parseDeploys((src as { deploys?: unknown }).deploys),
    interiors: parseInteriors((src as { interiors?: unknown }).interiors),
    arena: parseArena((src as { arena?: unknown }).arena),
    ambient: parseAmbient((src as { ambient?: unknown }).ambient),
    creatures: parseAmbient((src as { creatures?: unknown }).creatures),
  };
  if (parseWarnings.length) spec.warnings = parseWarnings;
  parseWarnings = null;
  return spec;
}

/** botSkill — a bare tier name, a per-axis mix ({aim:'impossible',
 *  move:'easy'}), or {alpha,bravo} per-side; unknown values fall back
 *  to the room default (medium). */
function parseBotSkill(raw: unknown): MapSpec['botSkill'] {
  const TIER = new Set(['easy', 'medium', 'hard', 'impossible']);
  const AXES = ['aim', 'move', 'react', 'jitter', 'temper'] as const;
  const one = (v: unknown): import('./botSkill.ts').BotSkillSpec | undefined => {
    if (typeof v === 'string') return TIER.has(v) ? v as import('./botSkill.ts').BotTier : undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const mix: import('./botSkill.ts').BotSkillMix = {};
      for (const k of AXES) {
        const t = (v as Record<string, unknown>)[k];
        if (typeof t === 'string' && TIER.has(t)) mix[k] = t as import('./botSkill.ts').BotTier;
      }
      return Object.keys(mix).length ? mix : undefined;
    }
    return undefined;
  };
  if (typeof raw === 'string') return one(raw);
  if (raw && typeof raw === 'object') {
    const o = raw as { alpha?: unknown; bravo?: unknown };
    const alpha = one(o.alpha), bravo = one(o.bravo);
    if (alpha || bravo) return { alpha, bravo };
  }
  return undefined;
}

/** Display title — printable words only; the wire echoes it verbatim
 *  into HUD text so keep it boring ASCII on purpose. */
function parseName(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[\w .&'()/-]{1,48}$/.test(raw) ? raw : undefined;
}

function parseMode(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[\w-]{1,32}$/.test(raw) ? raw : undefined;
}

function parseModes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((m): m is string => parseMode(m) !== undefined).slice(0, 8);
  return out.length ? out : undefined;
}

/** Modes a spec can legally host: the declared list; else its own mode
 *  plus every ruleset the geometry can actually serve. `ctf` is the only
 *  mode with authored requirements (two bases) — every other ruleset
 *  self-provisions (spawns fall back to the flat pool, rabbit mints its
 *  own neutral stand), so map = geometry and mode = ruleset on top.
 *  A mode-less spec remains "anything" (empty = unconstrained). */
export function specModes(spec: MapSpec | undefined): string[] {
  if (spec?.modes) return spec.modes;
  if (!spec?.mode) return [];
  const legal = ['tdm', 'nuggets', 'dm', 'rabbit', 'duel'];
  if (spec.bases?.alpha && spec.bases?.bravo) legal.unshift('ctf');
  return [...new Set([spec.mode, ...legal])];
}

function parseTerrain(raw: unknown): string | undefined {
  return parsePathField(raw, /\.bin$/, 2, 'terrain'); // t2/<map>/terrain.bin is 2 deep
}

/** Vertical gain — 0.1× (flats) to 8× (spikes). u8 quantization steps grow
 *  with it: past ~4× the 0.49m texel step is readable under skis. */
function parseHeightScale(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const v = Math.max(0.1, Math.min(8, raw));
  return v === 1 ? undefined : v;
}

function parseTileSize(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const v = Math.max(256, Math.min(4096, raw));
  return v === 1500 ? undefined : v;
}

function parseFog(raw: unknown): MapSpec['fog'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as { color?: unknown; distance?: unknown; visible?: unknown };
  if (!Array.isArray(f.color) || f.color.length < 3 ||
      !f.color.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v)))
    return undefined;
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return {
    color: [clamp01(f.color[0]), clamp01(f.color[1]), clamp01(f.color[2])],
    distance: num(f.distance, 0, 4000),
    visible: num(f.visible, 0, 8000),
  };
}

/** maps/-relative path — word-char dirs, filename must carry the
 *  extension `tail` requires. No dots in segments => no traversal. */
function parsePathField(raw: unknown, tail: RegExp, maxDepth = 2, label = 'path'): string | undefined {
  const reject = (): undefined => {
    if (raw !== undefined) specWarn(`${label}: ${JSON.stringify(raw)} rejected`);
    return undefined;
  };
  if (typeof raw !== 'string' || raw.length > 128) return reject();
  const parts = raw.split('/');
  if (parts.length > maxDepth + 1) return reject();
  for (const p of parts.slice(0, -1)) {
    if (!/^[\w-]{1,64}$/.test(p)) return reject();   // dirs: word chars only, no dots
  }
  if (!/^[\w-]{1,64}(\.[\w-]{1,8})?$/.test(parts[parts.length - 1]!)) return reject();
  return tail.test(raw) ? raw : reject();
}

function parseSpawns(raw: unknown): SpawnPoint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SpawnPoint[] = [];
  let dropped = 0;
  for (const s of raw) {
    if (!isVec(s)) { dropped++; continue; }
    const o = s as { r?: unknown; w?: unknown };
    out.push({
      x: s.x, y: s.y, z: s.z,
      r: typeof o.r === 'number' && Number.isFinite(o.r) ? Math.max(0, Math.min(400, o.r)) : undefined,
      w: typeof o.w === 'number' && Number.isFinite(o.w) && o.w > 0 ? Math.min(1000, o.w) : undefined,
    });
    if (out.length >= 32) break;
  }
  if (dropped) specWarn(`spawns: ${dropped} invalid points dropped`);
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
  // A present-but-broken base is an authored intent that failed — a CTF
  // spec with a typo'd bravo base silently plays with one flag.
  if (b.alpha !== undefined && !isVec(b.alpha)) specWarn('bases.alpha: invalid position dropped');
  if (b.bravo !== undefined && !isVec(b.bravo)) specWarn('bases.bravo: invalid position dropped');
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

const STRUCT_KINDS = new Set(['box', 'wall', 'pillar', 'ramp', 'root', 'stand', 'hull', 'kit', 'shield']);

/** Socket top above the flag's home pos — bot goals aimed at a home
 *  flag lift by this so pressers meet the pole, not the dirt. The socket
 *  itself is visual-only (mkFlagStand); a map that wants a platform
 *  authors a stand kit piece (katastand/flagtower — standTop snaps the
 *  home onto it) or an authored 'stand' box. */
export const FLAG_STAND_LIFT = 0.85;
const isVec = (s: unknown): s is Vec3like =>
  !!s && typeof s === 'object' &&
  Number.isFinite((s as Vec3like).x) &&
  Number.isFinite((s as Vec3like).y) &&
  Number.isFinite((s as Vec3like).z);

/** Validated structure list — bad entries dropped, sane clamps, cap 256. */
function parseStructures(raw: unknown): StructureSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StructureSpec[] = [];
  let dropped = 0;
  for (const s of raw) {
    const ok = (s as Record<string, unknown>)?.kind === 'kit';
    if (!s || typeof s !== 'object' ||
        typeof (s as Record<string, unknown>).kind !== 'string' ||
        !STRUCT_KINDS.has((s as Record<string, unknown>).kind as string) ||
        !isVec((s as Record<string, unknown>).pos) ||
        // kit pieces carry their own dims — every other kind needs size
        (!ok && !isVec((s as Record<string, unknown>).size)) ||
        (ok && (typeof (s as Record<string, unknown>).piece !== 'string' ||
                !((s as Record<string, unknown>).piece as string in KIT_HULLS)))) { dropped++; continue; }
    // Scale only exists for kit pieces; a bogus value drops the entry —
    // a silently-coerced wall scale would desync render from collision.
    const sc = (s as Record<string, unknown>).scale;
    if (sc !== undefined && (!Number.isFinite(Number(sc)) || Number(sc) < 0.25 || Number(sc) > 4)) { dropped++; continue; }
    const o = s as Record<string, unknown>;
    const sv = (o.size as Vec3like | undefined) ?? { x: 1, y: 1, z: 1 };
    const pv = o.pos as Vec3like;
    const size = {
      x: Math.max(0.2, Math.min(120, sv.x)),
      y: Math.max(0.2, Math.min(60, sv.y)),
      z: Math.max(0.2, Math.min(120, sv.z)),
    };
    const pos = {
      x: Math.max(-2000, Math.min(2000, pv.x)),
      y: Math.max(-100, Math.min(300, pv.y)),
      z: Math.max(-2000, Math.min(2000, pv.z)),
    };
    out.push({
      kind: o.kind as StructureSpec['kind'],
      piece: ok ? o.piece as string : undefined,
      pos, size,
      rotY: typeof o.rotY === 'number' && Number.isFinite(o.rotY) ? o.rotY : undefined,
      scale: ok && sc !== undefined ? Number(sc) : undefined,
      team: o.team === 'alpha' || o.team === 'bravo' ? o.team : undefined,
    });
    // Cap is a sanity bound, not a budget: T2 interior hull batches run
    // in the hundreds (each .dif decomposes into dozens of convex boxes).
    if (out.length >= 2048) break;
  }
  if (dropped) specWarn(`structures: ${dropped} invalid entries dropped`);
  return out.length ? out : undefined;
}

/** Validated authored-deployable list — kinds restricted to things that
 *  make sense unattended (no nuggets/drones chasing a phantom owner). */
function parseDeploys(raw: unknown): DeploySpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const AUTHORED = new Set(['turret', 'mine', 'station', 'shield', 'beacon', 'generator', 'sensor', 'baseturret']);
  const out: DeploySpec[] = [];
  let dropped = 0;
  for (const s of raw) {
    if (!s || typeof s !== 'object') { dropped++; continue; }
    const o = s as Record<string, unknown>;
    if (typeof o.kind !== 'string' || !AUTHORED.has(o.kind)) { dropped++; continue; }
    if (!isVec(o.pos)) { dropped++; continue; }
    const pos = {
      x: Math.max(-2000, Math.min(2000, o.pos.x)),
      y: Math.max(-100, Math.min(300, o.pos.y)),
      z: Math.max(-2000, Math.min(2000, o.pos.z)),
    };
    out.push({
      kind: o.kind as DeploySpec['kind'],
      pos,
      team: o.team === 'alpha' || o.team === 'bravo' ? o.team : undefined,
    });
    if (out.length >= 64) break;
  }
  if (dropped) specWarn(`deploys: ${dropped} invalid entries dropped`);
  return out.length ? out : undefined;
}

/** Validated interior placements — bare .dif basenames only (client maps
 *  them to t2/dif/*.glb), sane-clamped transforms, cap 256. */
function parseInteriors(raw: unknown): InteriorSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: InteriorSpec[] = [];
  let dropped = 0;
  for (const s of raw) {
    if (!s || typeof s !== 'object') { dropped++; continue; }
    const o = s as Record<string, unknown>;
    const file = typeof o.file === 'string' && /^[\w-]{1,64}\.dif$/i.test(o.file)
      ? o.file.toLowerCase() : undefined;
    if (!file || !isVec(o.pos)) { dropped++; continue; }
    const rot = Array.isArray(o.rot) && o.rot.length === 4
      && o.rot.every(v => typeof v === 'number' && Number.isFinite(v))
      ? o.rot as number[] : undefined;
    out.push({ file, pos: o.pos, rot, scale: isVec(o.scale) ? o.scale : undefined });
    if (out.length >= 256) break;
  }
  if (dropped) specWarn(`interiors: ${dropped} invalid placements dropped`);
  return out.length ? out : undefined;
}

/** Four non-negative weights, normalized. Anything malformed → undefined
 *  (sim falls back to its built-in mix). */
function parseBallMix(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const w = raw.map((v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0));
  return w.some((v) => v > 0) ? w : undefined;
}
