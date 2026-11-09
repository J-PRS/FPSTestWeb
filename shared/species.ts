/**
 * SPECIES — the one creature registry. A species is a DATA ROW, not a
 * class (Type Object pattern): the wire carries the species name and
 * both ends resolve the same row. `family` picks which movement sim
 * owns it; the per-species fields scale or override that family's
 * baseline constants.
 *
 * Adding a creature to an existing family = one row here (+ a parts
 * entry in the client's SWARM_SPECS for the render side). A new FAMILY
 * is one sim module + one SPECIES_FAMILY entry in creatureSim.ts —
 * spawn/step/damage sites never get another if-chain.
 */

export type SpeciesFamily = 'hop' | 'fly' | 'roll' | 'slither' | 'baneling' | 'totem';

export interface SpeciesRow {
  family: SpeciesFamily;
  /** Multiplier on the family's base speed (hop/dive/orbit/top). */
  speed?: number;
  health: number;       // base (uber still scales per family)
  bite: number;         // contact/beam/blast damage
  blast?: number;       // baneling blast radius
  aggro?: number;       // flat d² override for odd-sensing species
  pounceD?: number;     // flat pounce d² override
  orbitR?: number;      // flyer orbit radius
  orbitAlt?: number;    // flyer cruise altitude
}

export const SPECIES: Record<string, SpeciesRow> = {
  crawler: { family: 'hop',      speed: 1,  health: 70,  bite: 25 },
  scarab:  { family: 'hop',      speed: 1.35, health: 40,  bite: 15, aggro: 55 * 55, pounceD: 20 * 20 },
  rakk:    { family: 'fly',      speed: 1,  health: 50,  bite: 18 },
  gnat:    { family: 'fly',      speed: 1.5,  health: 20,  bite: 8,  orbitR: 10, orbitAlt: 8 },
  // Buzzard - the ambient kettle made real: high lazy orbit, fast fold-
  // dive, peck contact. Map-spawned via `creatures` pops; the wire species
  // name rides the same fly-family edges as rakk/gnat.
  buzzard: { family: 'fly',      speed: 1.25, health: 80,  bite: 20, orbitR: 20, orbitAlt: 16 },
  roller:  { family: 'roll',     speed: 1,  health: 120, bite: 30 },
  snake:   { family: 'slither',  speed: 1,  health: 45,  bite: 14 },
  baneling:{ family: 'baneling', speed: 1,  health: 15,  bite: 18, blast: 5 },
  totem:   { family: 'totem',               health: 200, bite: 15 },
};

/** Wire species name → owning family. Unknown names ride 'hop' — the
 *  same fallback makeSimCrawler always used. */
export function speciesFamily(species: string): SpeciesFamily {
  return SPECIES[species]?.family ?? 'hop';
}
