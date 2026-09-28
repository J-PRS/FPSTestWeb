import * as THREE from 'three';

import { MoveSim, MOVEMENT_CONFIG, type MoveState, type MoveInput, type Vec3Like } from '../../../shared/movement.js';

import { Terrain } from '../world/terrain.js';

// MOVEMENT_CONFIG now lives in shared/movement.ts — re-exported so existing
// imports keep working.
export { MOVEMENT_CONFIG };

export type MovementState = MoveState & { pos: THREE.Vector3; vel: THREE.Vector3 };
export type MovementInput = MoveInput;

// Adapts THREE-Terrain to the shared sim's plain-object surface interface.
class TerrainSurface {
  constructor(private terrain: Terrain) {}
  getHeight(x: number, z: number): number { return this.terrain.getHeight(x, z); }
  getNormal(x: number, z: number, out: Vec3Like): Vec3Like {
    const n = this.terrain.getNormal(x, z); // may be a shared scratch — copy fields now
    out.x = n.x; out.y = n.y; out.z = n.z;
    return out;
  }
}

/**
 * Client-side movement controller — thin wrapper over the shared MoveSim
 * so the server can replay the exact same physics from inputMove traffic.
 * The public surface (setInput/getState/setState/update) is unchanged.
 */
export class MovementController {
  private sim: MoveSim;
  private state: MovementState;

  constructor(terrain: Terrain, initialState: MovementState) {
    // The sim's state IS this.state — callers mutating via getState()
    // (yaw/pitch each frame) are visible to the sim immediately.
    this.state = initialState;
    this.sim = new MoveSim(new TerrainSurface(terrain), initialState);
  }

  setInput(input: Partial<MovementInput>): void { this.sim.setInput(input); }
  getState(): MovementState { return this.state; }
  setState(newState: MovementState): void { this.sim.setState(newState); }
  update(dt: number): void { this.sim.update(dt); }
}
