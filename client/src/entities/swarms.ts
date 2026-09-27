import * as THREE from 'three';
import { SpeciesSwarm, InstancedBlobShadows, type SwarmPart, type SwarmSlotOwner } from './swarm.js';
import type { Terrain } from '../world/terrain.js';

export type { SwarmPart, SwarmSlotOwner } from './swarm.js';

// Per-species instanced renderers — created lazily on first spawn so the
// scene only pays for species actually in play. Capacity per species is
// generous: slots are cheap, and a full swarm just refuses to spawn.
interface SwarmSpec { parts: () => SwarmPart[]; capacity: number }

const swarms = new Map<string, SpeciesSwarm>();
let shadows: InstancedBlobShadows | null = null;
let registryScene: THREE.Scene | null = null;
let specTable: Record<string, SwarmSpec> = {};

/** Called once at boot — scene + terrain the swarm layers live in. */
export function initSwarms(scene: THREE.Scene, terrain: Terrain, specs: Record<string, SwarmSpec>): void {
  registryScene = scene;
  specTable = specs;
  shadows = new InstancedBlobShadows(scene, terrain);
}

export function getSwarm(species: string): SpeciesSwarm | null {
  const existing = swarms.get(species);
  if (existing) return existing;
  const spec = specTable[species];
  if (!spec || !registryScene) return null;
  const swarm = new SpeciesSwarm(registryScene, spec.parts(), spec.capacity);
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
  return true;
}

export function freeSlots(species: string, owner: SwarmSlotOwner): void {
  swarms.get(species)?.free(owner.swarmSlot);
  if (owner.shadowSlot >= 0) shadows?.free(owner);
}

// No flush pass needed — SpeciesSwarm.setMatrix/setColor and
// InstancedBlobShadows.set flag their own buffers dirty per write.
