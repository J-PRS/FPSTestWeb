/**
 * Declarative match definition - a room named <X> looks for maps/<X>.json
 * next to the server and takes its mode + creature population from it.
 * Everything is optional; missing fields fall back to these defaults, so a
 * spec can override one knob without restating the rest.
 *
 * This is the seed of a real map format - spawn anchors, bases and
 * objectives land here next; the file already decides what a match IS.
 */

import { MODES, type TeamId } from './teams.ts';
import { KIT_HULLS, type Vec3like } from './structKits.js';
import type { BotSkillSpec,BotTier,BotSkillMix } from './botSkill.ts';
import type { DeployKind } from './deployables.ts';

export interface BallPopulation {
  /** solo population */
  base: number;
  /** extra per additional player */
  perPlayer: number;
  /** hard ceiling */
  max: number;
}

/** Ambient particle kinds a map may dial - mirrors the client's AmbientKind. */
export const WEATHER_KINDS = ['dust', 'embers', 'ash', 'snow'] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];
/** Per-kind particle intensity: 0 = off, 1 = full, 2 = thick. A kind left
 *  out is off; an absent `weather` block means the engine's default trio. */
export type WeatherSpec = Partial<Record<WeatherKind, number>>;
/** Procedural-atmosphere overrides - mirrors the client's
 *  AtmosphericSkyParams. Absent fields keep the engine SKY_* constants. */
export interface AtmosphereSpec {
  /** Rayleigh multiplier - 1 = engine default, >1 deepens/saturates sky. */
  rayleigh?: number;
  /** Mie multiplier - 1 = engine default, >1 hazier/smokier air. */
  mie?: number;
  /** Night star field brightness (absolute; 0 hides stars). */
  starIntensity?: number;
  /** Sun radiance multiplier - 1 = engine default, <1 dims/overcast. */
  sunIntensity?: number;
  /** Sun elevation, 0-1: 0 = midnight, .25 = sunrise, .5 = noon,
   *  .75 = sunset. Default .38 (mid-morning). Moves the light, so a dusk
   *  value rakes shadows long and reddens the sky. */
  timeOfDay?: number;
  /** Sun heading in degrees off +X (0 = +X, 90 = +Z). Default 0. */
  sunAzimuth?: number;
  /** Atmospheric turbidity multiplier (haze thickness). 1 = engine default. */
  turbidity?: number;
  /** Mie forward-scatter lobe 0-.95 - a sunward glow blob. 0 = isotropic. */
  mieDirectionalG?: number;
  /** Rayleigh dipole 0-1 - bright/dim sky sides. 0 = flat. */
  rayleighDirectional?: number;
}

/** Gameplay water - a global sea level the sims treat as a buoyant volume
 *  (players/bots slow and float below it), plus the client surface look.
 *  `level` is world Y in the same meters as terrain height (see heightfield);
 *  a map is "under water" wherever its terrain samples below `level`. Absent
 *  = no water at all, so every non-coastal map is unchanged. */
export interface WaterSpec {
  /** Sea-surface height in world meters (terrain space). Required. */
  level: number;
  /** Near-surface tint [r,g,b] - the shallow look. */
  color?: [number, number, number];
  /** Deep-water tint [r,g,b] - where the floor is far below. */
  deep?: [number, number, number];
  /** false = decorative water - the surface renders and terrain tints,
   *  but neither sim applies drag/buoy/swim (wading stays full-speed).
   *  Absent = real water. */
  swim?: boolean;
}

export interface MapSpec {
  /** Human title for HUD/chrome ("Dangerous Crossing"). Absent = the
   *  spec's filename, prettified client-side. */
  name?: string;
  /** Default mode when the host doesn't pick one. */
  mode?: string;
  /** Excluded from the menu map list but still joinable by name -
   *  test grounds and half-built maps live here. */
  hidden?: boolean;
  /** Modes this map can host - map = geometry+spawns+bases, mode = the
   *  ruleset on top. Absent = own `mode` + every self-provisioning
   *  ruleset (ctf additionally requires `bases`); declared = exact list,
   *  for maps that need to narrow the default. */
  modes?: string[];
  balls: BallPopulation;
  /** Spawn anchors - farthest-from-enemies pick among these. Absent = the
   *  server's default spawn ring. `r` makes the anchor a sphere: the pick
   *  scatters to a random point inside the radius (T2 SpawnSpheres are
   *  volumes - without it every spawn lands on the center). `w` is the
   *  sphere's authored selection weight. */
  spawns?: SpawnPoint[];
  /** Team-owned spawn spheres (T2 missions group SpawnSpheres under
   *  Team1/Team2). When present for a team, that side spawns only from
   *  its own spheres. */
  teamSpawns?: { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] };
  /** Objective anchors per team - flag stands, capture rings, generators.
   *  Generic positions the mode interprets (ctf: flag stands). */
  bases?: { alpha?: Vec3like; bravo?: Vec3like };
  /** Server-driven filler players - wandering, shootable, team-balanced. */
  bots?: number;
  /** Bot-fill floor: keep at least this many total bodies in the room by
   *  spawning/retiring bots as humans come and go. Distinct from `bots`
   *  (a fixed spawn count) - fill reacts to joins and quits. */
  botFill?: number;
  /** Per-room seat cap - overrides the server-wide maxPlayers for rooms
   *  minted on this spec (a 1v1 duel is 2). Absent = global budget. */
  maxPlayers?: number;
  /** Standing lobby: the room mints at boot and never disposes for
   *  emptiness - always joinable, hibernates while nobody's in it. */
  standing?: boolean;
  /** Spec-minted room modifiers - standing rooms carry them since their
   *  mint path takes no join spec. igun implies gungame. */
  gungame?: boolean;
  igun?: boolean;
  /** Per-spec match tuning - igun rooms want a longer climb than dm's
   *  100-pt/10-min contract. Undefined = the mode's own numbers. */
  winAt?: number;
  timeLimitS?: number;
  /** Points per player frag - dm pays 10, which makes "score" a disguised
   *  frag count. Set 1 to make scoreboard points read as frags. */
  ptsPlayerKill?: number;
  /** Difficulty band for spawned bots - one tier for the whole lobby, or
   *  {alpha,bravo} to handicap sides differently. Per-bot variance rolls
   *  around the band, so a team's bots aren't clones. */
  botSkill?: BotSkillSpec | { alpha?: BotSkillSpec; bravo?: BotSkillSpec };
  /** Spawn weights per ball variant [common, mid, large, elite] - default
   *  [0.84, 0.07, 0.04, 0.05]. Lets a map go all-elite or fodder-only. */
  ballMix?: number[];
  /** Heightmap filename under maps/ (e.g. "ravine.bin" or
   *  "t2/escalade/terrain.bin" - one subdir deep) - a different terrain
   *  for this room's BallSim. Absent = the server's default field. */
  terrain?: string;
  /** Vertical gain on the room's field - multiplies the base 125m scale
   *  (0.1-8). Applies to spec.terrain AND the default field alike; the
   *  value rides the wire so client prediction and render agree. */
  heightScale?: number;
  /** Meters one heightmap wrap covers (256-4096) - T2 ports carry their
   *  native 2048m tile so nothing on the map is squished horizontally.
   *  Absent = the engine default 1500. Rides the wire like heightScale. */
  tileSize?: number;
  /** Conquest lattice authored per map - `n` is the grid dimension,
   *  `span` the lattice's world span in meters. The playable knob is
   *  cell size (~200m = a ski hop), not map size, so a 1.5km terrain
   *  authors a tighter arena than tileSize implies. Absent = derive
   *  both from tileSize. */
  conquest?: { n?: number; span?: number };
  /** Mission-authored haze (T2 Sky block): `color` is the fog tint
   *  [r,g,b], `distance` the fog start, `visible` where full fog
   *  swallows the world. `horizon` [r,g,b] overrides the sky's
   *  horizon tint. Absent = engine default haze. Client-only. */
  fog?: { color: [number, number, number]; distance?: number; visible?: number; horizon?: [number, number, number] };
  /** Gameplay water - one global sea level (see WaterSpec). Absent = dry. */
  water?: WaterSpec;
  /** Baked terrain albedo under maps/ (e.g. "t2/escalade/albedo.png") -
   *  client-only dressing; the sims never read it. */
  terrainTex?: string;
  /** Procedural palette id for the terrain shader (0=mixed, 1=desert,
   *  2=grassland, 3=snow, 4=volcanic, 5=badlands, 6=coast, 7=desert
   *  hard-sun - desert palette, pure sun·diff² lighting). Client-only;
   *  absent = the shader's default desert. */
  terrainPreset?: number;
  /** Skybox dir under maps/ containing px/nx/py/ny/pz/nz.png - replaces
   *  the procedural sky when set. Client-only. */
  sky?: string;
  /** Ambient particle weather - per-kind intensity {dust,embers,ash,snow}.
   *  0 = off, 1 = full, >1 thickens. Absent = the engine's default trio
   *  (dust+embers+ash), so pre-weather maps render unchanged. Client-only
   *  dressing - the sims never read it. */
  weather?: WeatherSpec;
  /** Procedural-sky tuning (scattering/haze/star/sun). Overrides the
   *  engine's SKY_* constants for this map; ignored when a baked `sky`
   *  box replaces the procedural dome. Client-only. */
  atmosphere?: AtmosphereSpec;
  /** Static structures - axis-aligned boxes the server echoes into
   *  gameState so every client builds the same base compounds/cover.
   *  `kind` selects the renderer; `pos` is the piece's center. */
  structures?: StructureSpec[];
  /** Authored base assets - live deployables (generator, turret, sensor,
   *  pad) the server seeds at room open instead of waiting for a plant.
   *  Destructible, repairable, and they respawn on a long fuse - the
   *  Tribes generator economy. `team` makes them faction-owned. */
  deploys?: DeploySpec[];
  /** Placed interior meshes - converted .dif→.glb buildings. `file` is a
   *  bare basename resolved to maps/t2/dif/<name>.glb client-side; `pos` is
   *  already in our meters; `rot` is a raw T2 axis-angle [x,y,z,deg];
   *  `scale` is pre-squashed into our axes. */
  interiors?: InteriorSpec[];
  /** Arena boundary - a dome centered on {x,z} with this radius. Echoed to
   *  clients for the barrier render; server uses it for out-of-bounds
   *  checks (future: damage/skid-push on contact). */
  arena?: { x: number; z: number; radius: number };
  /** Kill zone - world Y below which a body dies ("fell out of the
   *  arena"). The heightfield is always there, so a terrainless arena
   *  needs this: drop below the deck and the sim ends you. Absent = no
   *  kill zone and every other map plays exactly as before. */
  killY?: number;
  /** Ambient species population overrides - { crawler: 0 } silences a
   *  species, { overlord: 4 } makes a boss map. Keys are species names
   *  ('crawler','seeker','rakk','strifer','gnat',...); absent = defaults.
   *  These are client-side ambience - they don't deal damage or sync. */
  ambient?: Record<string, number>;
  /** Server-authoritative creature population - { crawler: 6 } spawns
   *  real, replicated, damage-dealing/killable melee species via
   *  CreatureSim (shared/creatureSim.ts). Distinct from `ambient` which
   *  is client-side dressing only. */
  creatures?: Record<string, number>;
  /** Parse diagnostics - every input resolveMapSpec coerced, clamped, or
   *  dropped, collected at load. mapCatalog logs them so a typo'd field
   *  in a maps/*.json announces itself instead of silently defaulting. */
  warnings?: string[];
}

export interface DeploySpec {
  kind: DeployKind;
  pos: Vec3like;
  team?: TeamId;
}

export interface StructureSpec {
  /** 'stand' collides like a box but the client's generic box renderer
   *  skips it - the visual is the real dais mesh; the spec is the hull. */
  /** 'hull' is collision-only like 'stand' - T2 interior convex-hull
   *  boxes emitted by the porter; the real mesh is the visual. */
  /** 'shield' is a team-gated energy pane: collides for everyone EXCEPT
   *  `team` - allies walk and shoot through, enemies hit a wall. The
   *  client renders it as a translucent barrier; a team-less shield is
   *  legal but pointless (blocks everyone, same as a wall). */
  kind: 'box' | 'wall' | 'pillar' | 'ramp' | 'root' | 'stand' | 'hull' | 'kit' | 'shield';
  /** 'kit' pieces render through the structKit builders and collide via
   *  KIT_HULLS (shared/structKits) - `size` is ignored for them. */
  piece?: string;
  /** 'kit' pieces: uniform world scale applied to the render AND the
   *  hull expansion - one knob, no parity seam. Default 1. */
  scale?: number;
  pos: Vec3like;
  size: Vec3like;
  /** Y-rotation in radians (ramps/boxes), default 0. */
  rotY?: number;
  /** Team tint - 'alpha'|'bravo' bases color differently, else neutral. */
  team?: TeamId;
}

export type { Vec3like };

/** Spawn anchor - a point, or a sphere volume when `r` > 0. */
export interface SpawnPoint extends Vec3like {
  /** Sphere radius in meters - spawn scatters inside it. */
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

// Parse-warning collector - resolveMapSpec opens the window, every
// parser pushes, the finished spec carries the list as `warnings`.
// A typo'd maps/*.json used to fall back or clamp SILENTLY (the flag
// base that snapped to a default, the bots: "8" string that dropped) -
// now every coerced/rejected input reports itself at load.
let parseWarnings: string[] | null = null;
const specWarn = (m: string): void => { parseWarnings?.push(m); };

const clampInt = (v: unknown, lo: number, hi: number, fallback: number, label: string): number => {
  if (v === undefined) {return fallback;}
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    specWarn(`${label}: non-numeric value dropped (${JSON.stringify(v)})`);
    return fallback;
  }
  const c = Math.max(lo, Math.min(hi, Math.floor(v)));
  if (c !== v) {specWarn(`${label}: ${v} clamped to ${c} (${lo}..${hi})`);}
  return c;
};

/** Merge a parsed JSON blob over the defaults - never trusts the file. */
/** Strict-JSON.parse wrapper that tolerates // and block comments -
 *  spec files are hand-authored, so inline notes are legitimate. The
 *  regex walks string literals intact, so only real comment tokens are
 *  stripped (a "//" inside a quoted value survives). Single chokepoint
 *  for server catalog, client solo fetch and tests. */
export function parseMapSpecJson(text: string): unknown {
  return JSON.parse(text.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m): string => (m.startsWith('/') ? '' : m)));
}

/** Four non-negative weights, normalized. Anything malformed → undefined
 *  (sim falls back to its built-in mix). */
function parseBallMix(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) {return undefined;}
  const w = raw.map((v): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
  return w.some((v): boolean => v > 0) ? w : undefined;
}



/** Validated interior placements - bare .dif basenames only (client maps
 *  them to t2/dif/*.glb), sane-clamped transforms, cap 256. */
const isVec = (s: unknown): s is Vec3like =>
  Boolean(s) && typeof s === 'object' &&
  Number.isFinite((s as Vec3like).x) &&
  Number.isFinite((s as Vec3like).y) &&
  Number.isFinite((s as Vec3like).z);
/** One interior entry: .dif file + position required; rot/scale optional. */
function parseInterior(s: unknown): InteriorSpec | null {
  if (!s || typeof s !== 'object') {return null;}
  const o = s as Record<string, unknown>;
  const file = typeof o.file === 'string' && /^[\w-]{1,64}\.dif$/i.test(o.file)
    ? o.file.toLowerCase() : undefined;
  if (!file || !isVec(o.pos)) {return null;}
  const rot = Array.isArray(o.rot) && o.rot.length === 4
    && o.rot.every((v): boolean => typeof v === 'number' && Number.isFinite(v))
    ? o.rot as number[] : undefined;
  return { file, pos: o.pos, rot, scale: isVec(o.scale) ? o.scale : undefined };
}

function parseInteriors(raw: unknown): InteriorSpec[] | undefined {
  if (!Array.isArray(raw)) {return undefined;}
  const out: InteriorSpec[] = [];
  let dropped = 0;
  for (const s of raw) {
    const it = parseInterior(s);
    if (!it) {dropped += 1; continue;}
    out.push(it);
    if (out.length >= 256) {break;}
  }
  if (dropped) {specWarn(`interiors: ${dropped} invalid placements dropped`);}
  return out.length > 0 ? out : undefined;
}



/** Validated authored-deployable list - kinds restricted to things that
 *  make sense unattended (no nuggets/drones chasing a phantom owner). */
function parseDeploys(raw: unknown): DeploySpec[] | undefined {
  if (!Array.isArray(raw)) {return undefined;}
  const AUTHORED = new Set(['turret', 'mine', 'station', 'shield', 'beacon', 'generator', 'sensor', 'baseturret']);
  const out: DeploySpec[] = [];
  let dropped = 0;
  for (const s of raw) {
    if (!s || typeof s !== 'object') {dropped += 1; continue; }
    const o = s as Record<string, unknown>;
    if (typeof o.kind !== 'string' || !AUTHORED.has(o.kind)) {dropped += 1; continue; }
    if (!isVec(o.pos)) {dropped += 1; continue; }
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
    if (out.length >= 64) {break;}
  }
  if (dropped) {specWarn(`deploys: ${dropped} invalid entries dropped`);}
  return out.length > 0 ? out : undefined;
}



/** Validated structure list - bad entries dropped, sane clamps, cap 256. */
function parseStructures(raw: unknown): StructureSpec[] | undefined {
  if (!Array.isArray(raw)) {return undefined;}
  const out: StructureSpec[] = [];
  let dropped = 0;
  for (const s of raw) {
    const ok = (s as Record<string, unknown>)?.kind === 'kit';
    if (!s || typeof s !== 'object' ||
        typeof (s as Record<string, unknown>).kind !== 'string' ||
        !STRUCT_KINDS.has((s as Record<string, unknown>).kind as string) ||
        !isVec((s as Record<string, unknown>).pos) ||
        // kit pieces carry their own dims - every other kind needs size
        (!ok && !isVec((s as Record<string, unknown>).size)) ||
        (ok && (typeof (s as Record<string, unknown>).piece !== 'string' ||
                !((s as Record<string, unknown>).piece as string in KIT_HULLS)))) {dropped += 1; continue; }
    // Scale only exists for kit pieces; a bogus value drops the entry -
    // a silently-coerced wall scale would desync render from collision.
    const sc = (s as Record<string, unknown>).scale;
    // Sky-arena piers stretch past 4× for the long drops - the cap is a
    // typo guard, not a proportion rule.
    if (sc !== undefined && (!Number.isFinite(Number(sc)) || Number(sc) < 0.25 || Number(sc) > 8)) {dropped += 1; continue; }
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
    if (out.length >= 2048) {break;}
  }
  if (dropped) {specWarn(`structures: ${dropped} invalid entries dropped`);}
  return out.length > 0 ? out : undefined;
}



function parseArena(raw: unknown): MapSpec['arena'] {
  if (!raw || typeof raw !== 'object') {return undefined;}
  const a = raw as { x?: unknown; z?: unknown; radius?: unknown };
  if (!Number.isFinite(a.x) || !Number.isFinite(a.z) || !Number.isFinite(a.radius)) {return undefined;}
  const radius = Math.max(10, Math.min(750, a.radius as number));
  return { x: a.x as number, z: a.z as number, radius };
}

/** Kill zone height - a finite world Y in metres. Absent = no zone. */
function parseKillY(raw: unknown): number | undefined {
  if (raw === undefined) {return undefined;}
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    specWarn('killY: non-numeric value dropped');
    return undefined;
  }
  return Math.max(-2000, Math.min(2000, raw));
}



function parseAmbient(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {return undefined;}
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[\w-]{1,24}$/.test(k)) {continue;}
    if (typeof v === 'number' && Number.isFinite(v)) {out[k] = Math.max(0, Math.min(200, Math.floor(v)));}
  }
  return Object.keys(out).length > 0 ? out : undefined;
}



function parseBases(raw: unknown): MapSpec['bases'] {
  if (!raw || typeof raw !== 'object') {return undefined;}
  const b = raw as { alpha?: unknown; bravo?: unknown };
  // A present-but-broken base is an authored intent that failed - a CTF
  // spec with a typo'd bravo base silently plays with one flag.
  if (b.alpha !== undefined && !isVec(b.alpha)) {specWarn('bases.alpha: invalid position dropped');}
  if (b.bravo !== undefined && !isVec(b.bravo)) {specWarn('bases.bravo: invalid position dropped');}
  const out: MapSpec['bases'] = {
    alpha: isVec(b.alpha) ? b.alpha : undefined,
    bravo: isVec(b.bravo) ? b.bravo : undefined,
  };
  return out.alpha || out.bravo ? out : undefined;
}



function parseTeamSpawns(raw: unknown): MapSpec['teamSpawns'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {return undefined;}
  const t = raw as { alpha?: unknown; bravo?: unknown };
  const alpha = parseSpawns(t.alpha);
  const bravo = parseSpawns(t.bravo);
  return alpha || bravo ? { alpha, bravo } : undefined;
}



function parseSpawns(raw: unknown): SpawnPoint[] | undefined {
  if (!Array.isArray(raw)) {return undefined;}
  const out: SpawnPoint[] = [];
  let dropped = 0;
  for (const s of raw) {
    if (!isVec(s)) {dropped += 1; continue; }
    const o = s as { r?: unknown; w?: unknown };
    out.push({
      x: s.x, y: s.y, z: s.z,
      r: typeof o.r === 'number' && Number.isFinite(o.r) ? Math.max(0, Math.min(400, o.r)) : undefined,
      w: typeof o.w === 'number' && Number.isFinite(o.w) && o.w > 0 ? Math.min(1000, o.w) : undefined,
    });
    if (out.length >= 32) {break;}
  }
  if (dropped) {specWarn(`spawns: ${dropped} invalid points dropped`);}
  return out.length > 0 ? out : undefined;
}



/** maps/-relative path - word-char dirs, filename must carry the
 *  extension `tail` requires. No dots in segments => no traversal. */
function parsePathField(raw: unknown, tail: RegExp, maxDepth = 2, label = 'path'): string | undefined {
  const reject = (): undefined => {
    if (raw !== undefined) {specWarn(`${label}: ${JSON.stringify(raw)} rejected`);}
    return undefined;
  };
  if (typeof raw !== 'string' || raw.length > 128) {return reject();}
  const parts = raw.split('/');
  if (parts.length > maxDepth + 1) {return reject();}
  for (const p of parts.slice(0, -1)) {
    if (!/^[\w-]{1,64}$/.test(p)) {return reject();}   // dirs: word chars only, no dots
  }
  if (!/^[\w-]{1,64}(\.[\w-]{1,8})?$/.test(parts[parts.length - 1]!)) {return reject();}
  return tail.test(raw) ? raw : reject();
}



const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function parseFog(raw: unknown): MapSpec['fog'] {
  if (!raw || typeof raw !== 'object') {return undefined;}
  const f = raw as { color?: unknown; distance?: unknown; visible?: unknown; horizon?: unknown };
  if (!Array.isArray(f.color) || f.color.length < 3 ||
      !f.color.slice(0, 3).every((v): boolean => typeof v === 'number' && Number.isFinite(v)))
    {return undefined;}
  const vec3 = (v: unknown): [number, number, number] | undefined =>
    Array.isArray(v) && v.length >= 3 &&
    v.slice(0, 3).every((c): boolean => typeof c === 'number' && Number.isFinite(c))
      ? [clamp01(v[0]), clamp01(v[1]), clamp01(v[2])] : undefined;
  return {
    color: [clamp01(f.color[0]), clamp01(f.color[1]), clamp01(f.color[2])],
    distance: num(f.distance, 0, 4000),
    visible: num(f.visible, 0, 8000),
    horizon: vec3(f.horizon),
  };
}

/** Gameplay water - `level` is required and finite; tints are optional
 *  clamped 0..1 triples. A missing/invalid level drops the block entirely
 *  so a map never silently gains a sea at world zero. */
function parseWater(raw: unknown): MapSpec['water'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {return undefined;}
  const w = raw as { level?: unknown; color?: unknown; deep?: unknown };
  if (typeof w.level !== 'number' || !Number.isFinite(w.level)) {
    specWarn('water.level: required finite number - water block dropped');
    return undefined;
  }
  const vec3 = (v: unknown): [number, number, number] | undefined =>
    Array.isArray(v) && v.length >= 3 &&
    v.slice(0, 3).every((c): boolean => typeof c === 'number' && Number.isFinite(c))
      ? [clamp01(v[0]), clamp01(v[1]), clamp01(v[2])] : undefined;
  return { level: Math.max(-500, Math.min(2000, w.level)), color: vec3(w.color), deep: vec3(w.deep),
    swim: (w as { swim?: unknown }).swim === false ? false : undefined };
}

/** Weather intensities - known kinds only, clamped 0..2. An empty result
 *  is undefined so the client falls back to the default trio. */
function parseWeather(raw: unknown): WeatherSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {return undefined;}
  const out: WeatherSpec = {};
  let bad = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(WEATHER_KINDS as readonly string[]).includes(k) || typeof v !== 'number' || !Number.isFinite(v)) {
      bad += 1; continue;
    }
    out[k as WeatherKind] = Math.max(0, Math.min(2, v));
  }
  if (bad) {specWarn(`weather: ${bad} unknown/invalid kind(s) dropped`);}
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Atmosphere overrides - finite, clamped to ranges the shader stays sane in. */
function parseAtmosphere(raw: unknown): AtmosphereSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {return undefined;}
  const o = raw as Record<string, unknown>;
  const out: AtmosphereSpec = {};
  if (typeof o.rayleigh === 'number' && Number.isFinite(o.rayleigh)) {out.rayleigh = Math.max(0, Math.min(10, o.rayleigh));}
  if (typeof o.mie === 'number' && Number.isFinite(o.mie)) {out.mie = Math.max(0, Math.min(20, o.mie));}
  if (typeof o.starIntensity === 'number' && Number.isFinite(o.starIntensity)) {out.starIntensity = Math.max(0, Math.min(3, o.starIntensity));}
  if (typeof o.sunIntensity === 'number' && Number.isFinite(o.sunIntensity)) {out.sunIntensity = Math.max(0, Math.min(5, o.sunIntensity));}
  if (typeof o.timeOfDay === 'number' && Number.isFinite(o.timeOfDay)) {out.timeOfDay = Math.max(0, Math.min(1, o.timeOfDay));}
  if (typeof o.sunAzimuth === 'number' && Number.isFinite(o.sunAzimuth)) {out.sunAzimuth = ((o.sunAzimuth % 360) + 360) % 360;}
  if (typeof o.turbidity === 'number' && Number.isFinite(o.turbidity)) {out.turbidity = Math.max(0, Math.min(10, o.turbidity));}
  if (typeof o.mieDirectionalG === 'number' && Number.isFinite(o.mieDirectionalG)) {out.mieDirectionalG = Math.max(0, Math.min(0.95, o.mieDirectionalG));}
  if (typeof o.rayleighDirectional === 'number' && Number.isFinite(o.rayleighDirectional)) {out.rayleighDirectional = Math.max(0, Math.min(1, o.rayleighDirectional));}
  return Object.keys(out).length > 0 ? out : undefined;
}



function parseTileSize(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {return undefined;}
  const v = Math.max(256, Math.min(4096, raw));
  return v === 1500 ? undefined : v;
}



function parseConquest(raw: unknown): MapSpec['conquest'] {
  if (typeof raw !== 'object' || raw === null) {return undefined;}
  const o = raw as { n?: unknown; span?: unknown };
  const n = typeof o.n === 'number' && Number.isFinite(o.n) ? Math.max(2, Math.min(9, Math.round(o.n))) : undefined;
  const span = typeof o.span === 'number' && Number.isFinite(o.span) ? Math.max(200, Math.min(4096, o.span)) : undefined;
  return n !== undefined || span !== undefined ? { n, span } : undefined;
}



/** Vertical gain - 0.1× (flats) to 8× (spikes). u8 quantization steps grow
 *  with it: past ~4× the 0.49m texel step is readable under skis. */
function parseHeightScale(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {return undefined;}
  const v = Math.max(0.1, Math.min(8, raw));
  return v === 1 ? undefined : v;
}



function parseTerrain(raw: unknown): string | undefined {
  return parsePathField(raw, /\.bin$/, 2, 'terrain'); // t2/<map>/terrain.bin is 2 deep
}



function parseModes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {return undefined;}
  const out = raw.filter((m): m is string => parseMode(m) !== undefined).slice(0, 8);
  return out.length > 0 ? out : undefined;
}



function parseMode(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[\w-]{1,32}$/.test(raw) ? raw : undefined;
}



/** Display title - printable words only; the wire echoes it verbatim
 *  into HUD text so keep it boring ASCII on purpose. */
function parseName(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[\w .&'()/-]{1,48}$/.test(raw) ? raw : undefined;
}



/** botSkill - a bare tier name, a per-axis mix ({aim:'impossible',
 *  move:'easy'}), or {alpha,bravo} per-side; unknown values fall back
 *  to the room default (medium). */
function parseBotSkill(raw: unknown): MapSpec['botSkill'] {
  const TIER = new Set(['easy', 'medium', 'hard', 'impossible']);
  const AXES = ['aim', 'move', 'react', 'jitter', 'temper'] as const;
  const one = (v: unknown): BotSkillSpec | undefined => {
    if (typeof v === 'string') {return TIER.has(v) ? v as BotTier : undefined;}
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const mix: BotSkillMix = {};
      for (const k of AXES) {
        const t = (v as Record<string, unknown>)[k];
        if (typeof t === 'string' && TIER.has(t)) {mix[k] = t as BotTier;}
      }
      return Object.keys(mix).length > 0 ? mix : undefined;
    }
    return undefined;
  };
  if (typeof raw === 'string') {return one(raw);}
  if (raw && typeof raw === 'object') {
    const o = raw as { alpha?: unknown; bravo?: unknown };
    const alpha = one(o.alpha), bravo = one(o.bravo);
    if (alpha || bravo) {return { alpha, bravo };}
  }
  return undefined;
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
  if (balls.max < balls.base) {balls.max = balls.base;}

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
    maxPlayers: clampInt((src as { maxPlayers?: unknown }).maxPlayers, 1, 64, 0, 'maxPlayers') || undefined,
    standing: (src as { standing?: unknown }).standing === true ? true : undefined,
    gungame: (src as { gungame?: unknown }).gungame === true ? true : undefined,
    igun: (src as { igun?: unknown }).igun === true ? true : undefined,
    winAt: clampInt((src as { winAt?: unknown }).winAt, 1, 9999, 0, 'winAt') || undefined,
    timeLimitS: clampInt((src as { timeLimitS?: unknown }).timeLimitS, 30, 14_400, 0, 'timeLimitS') || undefined,
    ptsPlayerKill: clampInt((src as { ptsPlayerKill?: unknown }).ptsPlayerKill, 0, 999, -1, 'ptsPlayerKill') >= 0
      ? clampInt((src as { ptsPlayerKill?: unknown }).ptsPlayerKill, 0, 999, -1, 'ptsPlayerKill') : undefined,
    botSkill: parseBotSkill((src as { botSkill?: unknown }).botSkill),
    ballMix: parseBallMix((src as { ballMix?: unknown }).ballMix),
    // filename-only - the value is resolved under maps/ server-side, so
    // anything with a slash or dot-traversal is dropped on the floor
    terrain: parseTerrain((src as { terrain?: unknown }).terrain),
    heightScale: parseHeightScale((src as { heightScale?: unknown }).heightScale),
    tileSize: parseTileSize((src as { tileSize?: unknown }).tileSize),
    conquest: parseConquest((src as { conquest?: unknown }).conquest),
    fog: parseFog((src as { fog?: unknown }).fog),
    terrainTex: parsePathField((src as { terrainTex?: unknown }).terrainTex, /\.(?:png|jpe?g|webp)$/, 2, 'terrainTex'),
    terrainPreset: clampInt((src as { terrainPreset?: unknown }).terrainPreset, 0, 9, 0, 'terrainPreset') || undefined,
    sky: parsePathField((src as { sky?: unknown }).sky, /[\w-]{1,64}$/, 2, 'sky'),
    weather: parseWeather((src as { weather?: unknown }).weather),
    water: parseWater((src as { water?: unknown }).water),
    atmosphere: parseAtmosphere((src as { atmosphere?: unknown }).atmosphere),
    structures: parseStructures((src as { structures?: unknown }).structures),
    deploys: parseDeploys((src as { deploys?: unknown }).deploys),
    interiors: parseInteriors((src as { interiors?: unknown }).interiors),
    arena: parseArena((src as { arena?: unknown }).arena),
    killY: parseKillY((src as { killY?: unknown }).killY),
    ambient: parseAmbient((src as { ambient?: unknown }).ambient),
    creatures: parseAmbient((src as { creatures?: unknown }).creatures),
  };
  if (parseWarnings.length > 0) {spec.warnings = parseWarnings;}
  parseWarnings = null;
  return spec;
}

/** Modes a spec can legally host: the declared list; else its own mode
 *  plus every ruleset - modes are map-agnostic: spawns fall back to the
 *  flat pool, rabbit mints its own neutral stand, and ctf auto-places
 *  stands on geometry without authored bases (farthest spawn pair).
 *  A mode-less spec remains "anything" (empty = unconstrained). */
export function specModes(spec: MapSpec | undefined): string[] {
  if (spec?.modes) {return spec.modes;}
  if (!spec?.mode) {return [];}
  // Every ruleset in MODES is map-agnostic - the spec's own declared
  // mode rides along in case it names something older.
  return [...new Set([spec.mode, ...Object.keys(MODES)])];
}

const STRUCT_KINDS = new Set(['box', 'wall', 'pillar', 'ramp', 'root', 'stand', 'hull', 'kit', 'shield']);

/** Socket top above the flag's home pos - bot goals aimed at a home
 *  flag lift by this so pressers meet the pole, not the dirt. The socket
 *  itself is visual-only (mkFlagStand); a map that wants a platform
 *  authors a stand kit piece (katastand/flagtower - standTop snaps the
 *  home onto it) or an authored 'stand' box. */
export const FLAG_STAND_LIFT = 0.85;

