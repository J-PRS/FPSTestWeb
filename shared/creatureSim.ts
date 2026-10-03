/**
 * creatureSim — facade re-exporting the deterministic creature sims.
 * The substrate (crawler pilot + shared primitives) lives in
 * creatureCore.ts; each family has its own module (creatureFlyer,
 * creatureRoller, creatureSlither, creatureBaneling, creatureTotem).
 * Consumers keep importing from here so the wire/sim vocabulary stays
 * one import site.
 */

export * from './creatureCore.js';
export * from './creatureFlyer.js';
export * from './creatureRoller.js';
export * from './creatureSlither.js';
export * from './creatureBaneling.js';
export * from './creatureTotem.js';
export * from './species.js';

import type { Heightfield } from './heightfield.js';
import type { SimVec, StructureCollider } from './ballSim.js';
import { makeSimCrawler, stepCrawler, applyCrawlerDamage, type CrawlerEvent, type SimCrawler } from './creatureCore.js';
import { makeSimFlyer, stepFlyer, applyFlyerDamage, type SimFlyer } from './creatureFlyer.js';
import { makeSimRoller, stepRoller, applyRollerDamage, type SimRoller } from './creatureRoller.js';
import { makeSimSlither, stepSlither, applySlitherDamage, type SimSlither } from './creatureSlither.js';
import { makeSimBaneling, stepBaneling, applyBanelingDamage, type SimBaneling } from './creatureBaneling.js';
import { makeSimTotem, stepTotem, applyTotemDamage, type SimTotem } from './creatureTotem.js';
import type { SpeciesFamily } from './species.js';

/** Every family shares the same wire/sim field set — the union only
 *  matters at step/damage dispatch, discriminated by the `family` tag
 *  (replaces the old duck-typed `field in c` checks: a new family field
 *  could collide, a literal can't). */
export type SimBeing = SimCrawler | SimFlyer | SimRoller | SimSlither | SimBaneling | SimTotem;
export const isFlyer = (c: SimBeing): c is SimFlyer => c.family === 'fly';
export const isRoller = (c: SimBeing): c is SimRoller => c.family === 'roll';
export const isSlither = (c: SimBeing): c is SimSlither => c.family === 'slither';
export const isBaneling = (c: SimBeing): c is SimBaneling => c.family === 'baneling';
export const isTotem = (c: SimBeing): c is SimTotem => c.family === 'totem';

type StepFn = (c: SimBeing, dt: number, field: Heightfield,
  target: SimVec | null, authoritative: boolean,
  cols?: readonly StructureCollider[]) => CrawlerEvent | null;

/** One row per movement family — the only place family→behavior is
 *  bound. Spawn/step/damage sites index SPECIES_FAMILY[c.family] (or
 *  SPECIES_FAMILY[speciesFamily(name)]) instead of open-coding a chain;
 *  a new family is one module + one row, never another if-branch.
 *  `lift` is the spawn-time offset above the terrain surface. */
export interface FamilyDef {
  make(id: number, pos: SimVec, uber: boolean, seed: number, species: string): SimBeing;
  step: StepFn;
  damage(c: SimBeing, dmg: number): boolean;
  lift(c: SimBeing): number;
}
export const SPECIES_FAMILY: Record<SpeciesFamily, FamilyDef> = {
  hop: {
    make: makeSimCrawler,
    step: (c, dt, f, t, a, col) => c.family === 'hop' ? stepCrawler(c, dt, f, t, a, col) : null,
    damage: (c, d) => c.family === 'hop' ? applyCrawlerDamage(c, d) : false,
    lift: () => 0,
  },
  fly: {
    make: makeSimFlyer,
    step: (c, dt, f, t, a, col) => isFlyer(c) ? stepFlyer(c, dt, f, t, a, col) : null,
    damage: (c, d) => isFlyer(c) ? applyFlyerDamage(c, d) : false,
    lift: (c) => isFlyer(c) ? c.sp.ORBIT_ALT : 0, // flyers enter at cruise alt
  },
  roll: {
    make: makeSimRoller,
    step: (c, dt, f, t, a, col) => isRoller(c) ? stepRoller(c, dt, f, t, a, col) : null,
    damage: (c, d) => isRoller(c) ? applyRollerDamage(c, d) : false,
    lift: () => 1.6, // rollers ride the surface
  },
  slither: {
    make: makeSimSlither,
    step: (c, dt, f, t, a, col) => isSlither(c) ? stepSlither(c, dt, f, t, a, col) : null,
    damage: (c, d) => isSlither(c) ? applySlitherDamage(c, d) : false,
    lift: () => 0.5, // belly on the dirt
  },
  baneling: {
    make: makeSimBaneling,
    step: (c, dt, f, t, a, col) => isBaneling(c) ? stepBaneling(c, dt, f, t, a, col) : null,
    damage: (c, d) => isBaneling(c) ? applyBanelingDamage(c, d) : false,
    lift: () => 0.7, // sac skims low
  },
  totem: {
    make: makeSimTotem,
    step: (c, dt, f, t, a, col) => isTotem(c) ? stepTotem(c, dt, f, t, a, col) : null,
    damage: (c, d) => isTotem(c) ? applyTotemDamage(c, d) : false,
    lift: () => 0,
  },
};
