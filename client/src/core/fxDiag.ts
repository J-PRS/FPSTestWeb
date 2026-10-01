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
