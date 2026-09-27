// Sound bank — every effect is a tiny synthesized one-shot on Web Audio.
// Keep them short and distinct: in a fast shooter you read sounds by shape,
// not fidelity. Implementation lives in core/sfx/* — this barrel keeps
// the `sfx.*` call-site API unchanged.
export * from './sfx/util.js';
export * from './sfx/weapons.js';
export * from './sfx/beam.js';
export * from './sfx/player.js';
export * from './sfx/explosions.js';
export * from './sfx/world.js';
