import * as THREE from 'three';
import { SpeciesSwarm, InstancedBlobShadows, type SwarmPart, type SwarmSlotOwner } from './swarm.js';
import { GibPool } from '../effects/gibs.js';
import type { Terrain } from '../world/terrain.js';
import { registerDiag, markProbe } from '../core/fxDiag.js';
import { bakeVertexAO } from '../effects/vertexAO.js';

export type { SwarmPart, SwarmSlotOwner } from './swarm.js';

// Per-species instanced renderers — created lazily on first spawn so the
// scene only pays for species actually in play. `capacity` is the
// initial buffer size: species grow when full and idle-shrink after
// ~30s of low occupancy (checkShrink driven from updateGibs).
// `bake` runs the shared AO+grunge+wear pass over the part geometries —
// for mechanical species that want the gun-metal pipeline, not organics.
// What the gunlab needs to run a live specimen — every swarm-rendered
// entity shares this shape, so a preview needs no per-species wiring.
export interface LabEntity {
  pos: THREE.Vector3; radius: number;
  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void;
  dispose(): void;
}
export interface SwarmSpec {
  parts: () => SwarmPart[]; capacity: number; bake?: boolean;
  /** Lab/debug spawn — entities that don't fit the shared ctor (Ball) omit it. */
  spawn?: (scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) => LabEntity;
}

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
  if (existing) {return existing;}
  const spec = specTable[species];
  if (!spec || !registryScene) {return null;}
  const parts = spec.parts();
  if (spec.bake) {
    for (const p of parts) {
      // bakeMesh de-indexes geometry into a CLONE (indexed verts can't
      // hold per-corner attributes) — de-index in place FIRST, or every
      // baked attribute lands on a throwaway clone and the instanced
      // mesh renders the virgin buffer. And bake ONE part per host:
      // stacked parts at origin mutually occlude and the whole bake
      // floors out black — each part wants its own self-occlusion only.
      if (p.geometry.index) {p.geometry = p.geometry.toNonIndexed();}
      const host = new THREE.Group();
      host.add(new THREE.Mesh(p.geometry, p.material));
      bakeVertexAO(host, { grime: true, wearBoost: 0.7 }); // same grime+wear as the chaingun bake
    }
  }
  const swarm = new SpeciesSwarm(registryScene, parts, spec.capacity);
  // Aim-probe tags — a crosshair hit on any part mesh resolves to this
  // species + the owning entity through swarm.ownerAt.
  swarm.meshes.forEach((m, i): void => markProbe(m, { kind: 'species', species, swarm, part: i }));
  swarms.set(species, swarm);
  return swarm;
}

export function getShadows(): InstancedBlobShadows | null {
  return shadows;
}

/** Alloc both handles; fails only before initSwarms or on an unknown
 *  species — the pools themselves grow on demand and never fill. */
export function allocSlots(species: string, owner: SwarmSlotOwner): boolean {
  const swarm = getSwarm(species);
  if (!swarm || swarm.alloc(owner) < 0) {return false;}
  owner.shadowSlot = shadows?.alloc(owner) ?? -1;
  owner.swarmSpecies = species;
  return true;
}

export function freeSlots(species: string, owner: SwarmSlotOwner): void {
  swarms.get(species)?.free(owner.swarmSlot);
  if (owner.shadowSlot >= 0) {shadows?.free(owner);}
}

function getGibPool(species: string): GibPool | null {
  const existing = gibPools.get(species);
  if (existing) {return existing;}
  const swarm = getSwarm(species);
  if (!swarm || !registryScene) {return null;}
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
  if (!species || slot < 0) {return false;}
  const pool = getGibPool(species);
  if (!pool || !pool.burst(slot, center, impulseDir, inheritVel)) {return false;}
  freeSlots(species, owner as SwarmSlotOwner);
  owner.swarmSlot = -1;
  return true;
}

/** Per-frame gib integration — same tick as the shard debris update.
 *  Also the idle-shrink pass for the three grow-only capacity buffers:
 *  occupancy under a quarter for 30s contracts them back to initCap. */
export function updateGibs(dt: number): void {
  if (!registryTerrain) {return;}
  for (const pool of gibPools.values()) {pool.update(dt, registryTerrain);}
  const now = performance.now();
  for (const s of swarms.values()) {s.checkShrink(now);}
  for (const g of gibPools.values()) {g.checkShrink(now);}
  shadows?.checkShrink(now);
}

/** Capacity/live census for the Alt+Q dump — a species pinned at capacity
 *  or a gib pool that never drains shows up here before it starves. */
export function swarmStats(): Record<string, unknown> {
  const species: Record<string, { live: number; cap: number }> = {};
  for (const [k, s] of swarms) {species[k] = { live: s.liveCount, cap: s.capacity };}
  const gibs: Record<string, { live: number; cap: number }> = {};
  for (const [k, g] of gibPools) {gibs[k] = { live: g.live, cap: g.cap };}
  return {
    species,
    gibs,
    shadows: shadows ? { live: shadows.liveCount } : null,
  };
}

// No flush pass needed — SpeciesSwarm.setMatrix/setColor and
// InstancedBlobShadows.set flag their own buffers dirty per write.

// Alt+Q census section — species/gib/shadow swarm inventory.
registerDiag('swarm', (): { swarm: Record<string, unknown>; } => ({ swarm: swarmStats() }));
