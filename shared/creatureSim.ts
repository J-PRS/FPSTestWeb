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
