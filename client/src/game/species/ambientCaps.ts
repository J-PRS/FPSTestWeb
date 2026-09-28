// Live ambient-species cap overrides for the room we're in — fed by the
// map spec's `ambient` block via netHandlers. A species spawn gate calls
// capFor(species, defaultMax); absent override = the config default.
let overrides: Record<string, number> | null = null;

export function setAmbientCaps(map: Record<string, number> | null | undefined): void {
  overrides = map ?? null;
}

export function capFor(species: string, defaultMax: number): number {
  return overrides?.[species] ?? defaultMax;
}
