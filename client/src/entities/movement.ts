import * as THREE from 'three';

import { MoveSim, MOVEMENT_CONFIG, type MoveState, type MoveInput, type Vec3Like } from '../../../shared/movement.js';
import { SolidWorld } from '../../../shared/solidWorld.js';
import type { StructureSpec } from '../../../shared/mapSpec.js';

import { Terrain } from '../world/terrain.js';

// MOVEMENT_CONFIG now lives in shared/movement.ts — re-exported so existing
// imports keep working.
export { MOVEMENT_CONFIG };

export type MovementState = MoveState & { pos: THREE.Vector3; vel: THREE.Vector3 };
export type MovementInput = MoveInput;

// Adapts THREE-Terrain to the shared sim's plain-object surface interface.
// Map structures layer over the terrain — identical math to the server's
// FieldSurface so prediction and shadow agree about walls and floors.
class TerrainSurface {
  private solid: SolidWorld | null = null;
  constructor(private terrain: Terrain) {}
  setStructures(list: readonly StructureSpec[] | undefined): void {
    this.solid = list?.length ? SolidWorld.fromSpecs(list) : null;
  }
  getHeight(x: number, z: number): number {
    const g = this.terrain.getHeight(x, z);
    const t = this.solid?.topAt(x, z) ?? -Infinity;
    return t > g ? t : g;
  }
  getNormal(x: number, z: number, out: Vec3Like): Vec3Like {
    if ((this.solid?.topAt(x, z) ?? -Infinity) > this.terrain.getHeight(x, z)) {
      out.x = 0; out.y = 1; out.z = 0;
      return out;
    }
    const n = this.terrain.getNormal(x, z); // may be a shared scratch — copy fields now
    out.x = n.x; out.y = n.y; out.z = n.z;
    return out;
  }
  resolveBody(s: MoveState): void { this.solid?.resolveBody(s); }
}

/**
 * Client-side movement controller — thin wrapper over the shared MoveSim
 * so the server can replay the exact same physics from inputMove traffic.
 * The public surface (setInput/getState/setState/update) is unchanged.
 */
export class MovementController {
  private sim: MoveSim;
  private surface: TerrainSurface;
  private state: MovementState;

  constructor(terrain: Terrain, initialState: MovementState) {
    // The sim's state IS this.state — callers mutating via getState()
    // (yaw/pitch each frame) are visible to the sim immediately.
    this.state = initialState;
    this.surface = new TerrainSurface(terrain);
    this.sim = new MoveSim(this.surface, initialState);
  }

  /** Map structures for collision — swap on gameState/mapUpdate. */
  setStructures(list: readonly StructureSpec[] | undefined): void {
    this.surface.setStructures(list);
  }

  setInput(input: Partial<MovementInput>): void { this.sim.setInput(input); }
  /** Armor-class ground speed — must match the server's shadow or every
   *  ground move reads as a divergence. */
  setSpeedScale(scale: number): void { this.sim.speedScale = scale; }
  getState(): MovementState { return this.state; }
  setState(newState: MovementState): void { this.sim.setState(newState); }
  update(dt: number): void { this.sim.update(dt); }
}
