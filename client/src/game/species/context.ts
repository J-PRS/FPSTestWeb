import type { Targetable } from '../../entities/balls.js';
import type { EntitiesDeps } from '../entities.js';
import type { SpeciesKit } from '../speciesKit.js';

// Shared context every species family factory gets: game deps, the kit's
// damage/spawn/aggro funnels, and the registry every hittable thing joins.
export interface SpeciesCtx {
  deps: EntitiesDeps;
  kit: SpeciesKit;
  targets: Targetable[];
}
