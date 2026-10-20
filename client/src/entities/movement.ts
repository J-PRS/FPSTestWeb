import type * as THREE from 'three';

import { MoveSim, MOVEMENT_CONFIG, type BodyCapsule, type MoveState, type MoveInput, type Vec3Like } from '../../../shared/movement.js';
import { SolidWorld } from '../../../shared/solidWorld.js';
import { structureColliders, type StructureCollider } from '../../../shared/ballCollide.js';
import { FieldSurface } from '../../../shared/fieldSurface.js';
import type { StructureSpec } from '../../../shared/mapSpec.js';

import type { Terrain } from '../world/terrain.js';

// MOVEMENT_CONFIG now lives in shared/movement.ts — re-exported so existing
// imports keep working.
export { MOVEMENT_CONFIG };

export type MovementState = MoveState & { pos: THREE.Vector3; vel: THREE.Vector3 };
export type MovementInput = MoveInput;

// The client plugs its THREE-Terrain in as a bare ground sampler; the
// solid overlay (reach-bounded tops, flat normals, wall push-out) is the
// shared FieldSurface itself — there is no second adapter to drift. A
// client-side reimplementation once dropped the maxTop bound and
// teleported walkers onto structure roofs.
const terrainSampler = (terrain: Terrain) => ({
  getHeight: (x: number, z: number): number => terrain.getHeight(x, z),
  getNormal: (x: number, z: number, out: Vec3Like): Vec3Like => {
    const n = terrain.getNormal(x, z); // may be a shared scratch — copy fields now
    out.x = n.x; out.y = n.y; out.z = n.z;
    return out;
  },
});

/**
 * Client-side movement controller — thin wrapper over the shared MoveSim
 * so the server can replay the exact same physics from inputMove traffic.
 * The public surface (setInput/getState/setState/update) is unchanged.
 */
export class MovementController {
  private sim: MoveSim;
  private surface: FieldSurface;
  private state: MovementState;

  constructor(terrain: Terrain, initialState: MovementState) {
    // The sim's state IS this.state — callers mutating via getState()
    // (yaw/pitch each frame) are visible to the sim immediately.
    this.state = initialState;
    this.surface = FieldSurface.over(terrainSampler(terrain));
    this.sim = new MoveSim(this.surface, initialState);
  }

  /** Live deployable hulls — the Deployables array, shared by reference
   *  so mid-match plants/removals reach prediction without a re-attach. */
  private dyn?: readonly StructureCollider[];

  /** Map structures for collision — swap on gameState/mapUpdate. */
  setStructures(list: readonly StructureSpec[] | undefined): void {
    this.surface.solid = (list?.length || this.dyn?.length)
      ? new SolidWorld(structureColliders(list ?? []), this.dyn) : null;
  }

  /** Server mirrors this through RoomMoveSim.setDynamic — the prediction
   *  must collide with the same gear or every brush against a turret
   *  reads as divergence. */
  setDynamicCols(cols: readonly StructureCollider[]): void {
    this.dyn = cols;
    if (this.surface.solid) {this.surface.solid.dyn = cols;}
    else if (cols.length > 0) {this.surface.solid = new SolidWorld([], cols);}
  }

  setInput(input: Partial<MovementInput>): void { this.sim.setInput(input); }
  /** Armor-class ground speed — must match the server's shadow or every
   *  ground move reads as a divergence. */
  setSpeedScale(scale: number): void { this.sim.speedScale = scale; }
  /** Armor-class body: jet thrust divides by mass, and grounded/ceiling
   *  checks stand the body `eyeHeight` tall — must match the server's
   *  shadow or jets/headroom read as divergence. */
  setBody(mass: number, eyeHeight: number, bodyRadius: number): void {
    this.sim.mass = mass;
    this.sim.eyeHeight = eyeHeight;
    this.sim.bodyRadius = bodyRadius;
  }
  /** Sea-surface height — the map's water.level. Must mirror the server
   *  shadow or a swim reads as a divergence. Absent clears it. */
  setWaterLevel(level?: number): void { this.sim.waterLevel = level; }
  /** Tether snare the body stands in — the frame sets it from the live
   *  deployable roster, mirroring the server's per-tick copy. */
  setTether(tether?: { x: number; y: number; z: number; r: number }): void { this.sim.tether = tether; }
  /** Other players' capsules for contact resolve — the frame fills this
   *  from the remote roster (server shadows resolve the same bodies). */
  get bodies(): BodyCapsule[] { return this.sim.bodies; }
  set bodies(list: BodyCapsule[]) { this.sim.bodies = list; }
  /** Shared-list capsule skip — the sim ignores the body with this id. */
  set selfId(id: string) { this.sim.selfId = id; }

  getState(): MovementState { return this.state; }
  setState(newState: MovementState): void { this.sim.setState(newState); }
  update(dt: number): void { this.sim.update(dt); }
  /** Worst contact -v·n (m/s) since the last update — the T1 impact
   *  speed the fall-damage gate reads (see shared/movement.ts). */
  get landingImpact(): number { return this.sim.landingImpact; }
}
