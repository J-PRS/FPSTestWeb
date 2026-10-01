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
    } catch (e) {
      out[name] = { error: (e as Error).message };
    }
  }
  return out;
}

// Aim-probe tag contract — kind is a closed union so a tag the reader
// doesn't understand can't be written. Lives here (not aimProbe.ts)
// because the tagging modules are also the ones the probe imports back
// for identification; a leaf keeps the graph acyclic.
export interface DbgTag {
  kind: 'trailBatch' | 'instPool' | 'species' | 'blobShadows' | 'quarks' | 'beam';
  /** trailBatch: the batch whose slot was hit. */
  batch?: unknown;
  /** instPool: shell-kind label + pool for the lit-free-slot check. */
  label?: string;
  pool?: { free: number[] };
  /** species: registry name + which part mesh. */
  species?: string;
  swarm?: unknown;
  part?: number;
  /** quarks: the ParticleSystem (paused/particleNum read off it). */
  ps?: unknown;
}

/** Single write site for the probe contract — tag every render object an
 *  on-screen frozen VFX could ever be blamed on. */
export function markProbe(obj: { userData: Record<string, unknown> }, tag: DbgTag): void {
  obj.userData.dbg = tag;
}
