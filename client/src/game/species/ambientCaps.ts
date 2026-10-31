// Live ambient-species cap overrides for the room we're in - fed by the
// map spec's `ambient` block via netHandlers. A species spawn gate calls
// capFor(species); the default comes from SWARM_SPECS[].max.
import { SWARM_SPECS } from './registry.js';

let overrides: Record<string, number> | null = null;

export function setAmbientCaps(map: Record<string, number> | null | undefined): void {
  overrides = map ?? null;
}

export function capFor(species: string): number {
  return overrides?.[species] ?? SWARM_SPECS[species]?.max ?? 4;
}
