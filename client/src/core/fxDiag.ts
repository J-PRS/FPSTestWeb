// FX diagnostics registry: subsystems self-register a section provider
// once at module load, and the Alt+Q dump is assembled by merging them —
// adding a census never requires plumbing through gameLoop/stateDebug
// again. A throwing provider degrades to an error row instead of
// poisoning the whole dump.
export type DiagSection = Record<string, unknown>;

const providers = new Map<string, () => DiagSection>();

export function registerDiag(name: string, fn: () => DiagSection): void {
  providers.set(name, fn);
}

export function collectDiag(): DiagSection {
  const out: DiagSection = {};
  for (const [name, fn] of providers) {
    try {
      Object.assign(out, fn());
    } catch (error) {
      out[name] = { error: (error as Error).message };
    }
  }
  return out;
}

// Aim-probe tag contract — kind is a closed union so a tag the reader
// doesn't understand can't be written. Lives here (not aimProbe.ts)
// because the tagging modules are also the ones the probe imports back
// for identification; a leaf keeps the graph acyclic.
export interface DbgTag {
  kind: 'trailBatch' | 'instPool' | 'species' | 'blobShadows' | 'quarks' | 'beam' | 'gib' | 'fxMesh';
  /** trailBatch: the batch whose slot was hit. */
  batch?: unknown;
  /** instPool/beam/gib: shell-kind label + pool for the lit-free-slot check. */
  label?: string;
  pool?: { free: number[] };
  /** gib: the GibMeshPool (freeIdx drives the same lit-free check). */
  gib?: unknown;
  /** species: registry name + which part mesh. */
  species?: string;
  swarm?: unknown;
  part?: number;
  /** quarks: the ParticleSystem (paused/particleNum read off it). */
  ps?: unknown;
}

/** Single write site for the probe contract — tag every render object an
 *  on-screen frozen VFX could ever be blamed on. */
/** Visual-glitch alarm — invariants like "a ribbon's verts lie on one
 *  trajectory" that, when broken, paint garbage on screen. Each kind is
 *  counted for the diag dump AND logged loudly (rate-limited so a
 *  per-frame offender can't flood the shipped log). */
const glitchCounts: Record<string, number> = {};
/** Payload + timestamp of the last emitted line per kind — identical
 *  registrations within a burst are the same event logged twice (dual
 *  code paths, relay dupes); count them, log once with (xN). */
const glitchLast: Record<string, { payload: string; n: number }> = {};
/** Floats at 6dp turn every wire position into a 20-char token — 1dp is
 *  all a glitch read needs (meters/ticks, not microns). */
function compact(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown): unknown =>
    typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 10) / 10 : x);
}
/** Returns true when the occurrence was emitted — callers whose event is
 *  rare-but-important (parity misses) can warn through their own channel
 *  when the rate limiter swallowed the console line. */
export function glitch(kind: string, detail: Record<string, unknown> = {}): boolean {
  glitchCounts[kind] = (glitchCounts[kind] ?? 0) + 1;
  const n = glitchCounts[kind];
  const payload = compact(detail);
  const last = glitchLast[kind];
  if (last && last.payload === payload) {
    last.n += 1; // identical payload — one line, count the dupes
    return false;
  }
  const suppressed = last && last.n > 1 ? ` (x${last.n})` : '';
  glitchLast[kind] = { payload, n: 1 };
  if (n <= 3 || n % 100 === 0) {
    // Lazy import would devolve the module graph — Logger is core like us.
    // oxlint-disable-next-line no-console
    console.error(`[GLITCH:${kind}]${suppressed}`, payload);
    return true;
  }
  return false;
}
export function glitchCountsDump(): Record<string, number> { return Object.assign({}, glitchCounts); }

registerDiag('glitches', (): { [x: string]: number; } => glitchCountsDump());

export function markProbe(obj: { userData: Record<string, unknown> }, tag: DbgTag): void {
  obj.userData.dbg = tag;
}
