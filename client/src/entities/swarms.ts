import * as THREE from 'three';
import { SpeciesSwarm, InstancedBlobShadows, type SwarmPart, type SwarmSlotOwner } from './swarm.js';
import { GibPool } from './gibs.js';
import type { Terrain } from '../world/terrain.js';
import { registerDiag, markProbe } from '../core/fxDiag.js';

export type { SwarmPart, SwarmSlotOwner } from './swarm.js';

// Per-species instanced renderers — created lazily on first spawn so the
// scene only pays for species actually in play. Capacity per species is
// generous: slots are cheap, and a full swarm just refuses to spawn.
export interface SwarmSpec { parts: () => SwarmPart[]; capacity: number }

const swarms = new Map<string, SpeciesSwarm>();
const gibPools = new Map<string, GibPool>();
let shadows: InstancedBlobShadows | null = null;
let registryScene: THREE.Scene | null = null;
let registryTerrain: Terrain | null = null;
let specTable: Record<string, SwarmSpec> = {};

/** Called once at boot — scene + terrain the swarm layers live in. */
export function initSwarms(scene: THREE.Scene, terrain: Terrain, specs: Record<string, SwarmSpec>): void {
  registryScene = scene;
  registryTerrain = terrain;
  specTable = specs;
  shadows = new InstancedBlobShadows(scene, terrain);
}

export function getSwarm(species: string): SpeciesSwarm | null {
  const existing = swarms.get(species);
  if (existing) return existing;
  const spec = specTable[species];
  if (!spec || !registryScene) return null;
  const swarm = new SpeciesSwarm(registryScene, spec.parts(), spec.capacity);
  // Aim-probe tags — a crosshair hit on any part mesh resolves to this
  // species + the owning entity through swarm.ownerAt.
  swarm.meshes.forEach((m, i) => markProbe(m, { kind: 'species', species, swarm, part: i }));
  swarms.set(species, swarm);
  return swarm;
}

export function getShadows(): InstancedBlobShadows | null {
  return shadows;
}

/** Alloc both handles; returns false when either pool is full. */
export function allocSlots(species: string, owner: SwarmSlotOwner): boolean {
  const swarm = getSwarm(species);
  if (!swarm || swarm.alloc(owner) < 0) return false;
  owner.shadowSlot = shadows?.alloc(owner) ?? -1;
  owner.swarmSpecies = species;
  return true;
}

export function freeSlots(species: string, owner: SwarmSlotOwner): void {
  swarms.get(species)?.free(owner.swarmSlot);
  if (owner.shadowSlot >= 0) shadows?.free(owner);
}

function getGibPool(species: string): GibPool | null {
  const existing = gibPools.get(species);
  if (existing) return existing;
  const swarm = getSwarm(species);
  if (!swarm || !registryScene) return null;
  const pool = new GibPool(registryScene, swarm);
  gibPools.set(species, pool);
  return pool;
}

/**
 * Shatter a swarm-rendered body: every part instance becomes a gib at its
 * exact current world transform (pixel-identical handoff — no pop), then
 * the swarm + shadow slots free. Returns false for single-part species or
 * when the body already released its slot — callers fall back to shard
 * debris there.
 */
export function burstGibs(
  owner: Partial<SwarmSlotOwner>, center: THREE.Vector3,
  impulseDir: THREE.Vector3 | null, inheritVel: THREE.Vector3 | null,
): boolean {
  const species = owner.swarmSpecies;
  const slot = owner.swarmSlot ?? -1;
  if (!species || slot < 0) return false;
  const pool = getGibPool(species);
  if (!pool || !pool.burst(slot, center, impulseDir, inheritVel)) return false;
  freeSlots(species, owner as SwarmSlotOwner);
  owner.swarmSlot = -1;
  return true;
}

/** Per-frame gib integration — same tick as the shard debris update. */
export function updateGibs(dt: number): void {
  if (!registryTerrain) return;
  for (const pool of gibPools.values()) pool.update(dt, registryTerrain);
}

/** Capacity/live census for the Alt+Q dump — a species pinned at capacity
 *  or a gib pool that never drains shows up here before it starves. */
export function swarmStats(): Record<string, unknown> {
  const species: Record<string, { live: number; cap: number }> = {};
  for (const [k, s] of swarms) species[k] = { live: s.liveCount, cap: s.capacity };
  const gibs: Record<string, number> = {};
  for (const [k, g] of gibPools) gibs[k] = g.live;
  return {
    species,
    gibs,
    shadows: shadows ? { live: shadows.liveCount } : null,
  };
}

// No flush pass needed — SpeciesSwarm.setMatrix/setColor and
// InstancedBlobShadows.set flag their own buffers dirty per write.

// Alt+Q census section — species/gib/shadow swarm inventory.
registerDiag('swarm', () => ({ swarm: swarmStats() }));
