import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MovementController, type MovementState } from '../entities/movement.js';
import { MOVEMENT_CONFIG } from '../../../shared/movement.js';
import type { Terrain } from '../world/terrain.js';

// The client TerrainSurface must forward the sim's reach bound (feet +
// stepUp) into SolidWorld.topAt — before it did, a body walking into a
// tall structure read the roof as its floor and the ground clamp
// teleported it to the top. Bastion live repro: POS JUMP 10m/18m snaps
// onto the alpha bastion hull at (-450, ~20, 110) → y≈38.
const flatTerrain = {
  getHeight: (): number => 0,
  getNormal: (): { x: number; y: number; z: number; } => ({ x: 0, y: 1, z: 0 }),
} as unknown as Terrain;

const mkState = (): MovementState => ({
  pos: new THREE.Vector3(0, MOVEMENT_CONFIG.playerHeight, 0),
  vel: new THREE.Vector3(0, 0, 0),
  yaw: 0, pitch: 0, onGround: true, // yaw 0 → forward is +z
});

const TALL_BOX = [{
  kind: 'box' as const,
  pos: { x: 0, y: 0, z: 10 },
  size: { x: 8, y: 12, z: 8 },
}];

describe('client surface reach', (): void => {
  it('walking into a tall structure stops at the face, never snaps to the roof', (): void => {
    const mc = new MovementController(flatTerrain, mkState());
    mc.setStructures(TALL_BOX);
    mc.setInput({ forward: 1 });
    let peakY = -Infinity;
    for (let i = 0; i < 240; i += 1) { // 4s of held-forward pushing
      mc.update(1 / 60);
      peakY = Math.max(peakY, mc.getState().pos.y);
    }
    const s = mc.getState();
    // Never above standing eye height + step margin — the roof at y=12
    // must be unreachable by walking.
    expect(peakY).toBeLessThan(MOVEMENT_CONFIG.playerHeight + MOVEMENT_CONFIG.stepUp + 0.5);
    // And the face must actually block — no walking through the wall.
    expect(s.pos.z).toBeLessThan(6.5);
  });

  it('knee-high ledges still step up', (): void => {
    const mc = new MovementController(flatTerrain, mkState());
    mc.setStructures([{
      kind: 'box' as const,
      pos: { x: 0, y: 0, z: 10 },
      size: { x: 8, y: 0.4, z: 8 },
    }]);
    mc.setInput({ forward: 1 });
    for (let i = 0; i < 240; i += 1) {mc.update(1 / 60);}
    expect(mc.getState().pos.z).toBeGreaterThan(10); // climbed on and crossed
  });
});
