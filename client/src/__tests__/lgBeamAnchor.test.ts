import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { lgMuzzleAnchor } from '../game/lgAnchor.js';

// The beam must start at the gun EVERY frame — i.e. its world position,
// expressed in camera space, must be the same constant offset regardless
// of how fast or which way the player is moving. If the anchor were ever
// derived from a stale transform, strafing would drag it off the gun.

const EXPECT_X = 0.25, EXPECT_Y = -0.28, EXPECT_Z = -0.79;
const _anchor = new THREE.Vector3();
const _view = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

// Return the anchor expressed in camera space (undo rotation).
// Any lag/staleness shows up as this vector drifting from the constant.
function anchorInViewSpace(cam: THREE.PerspectiveCamera): THREE.Vector3 {
  lgMuzzleAnchor(cam, _anchor);
  _view.copy(_anchor).sub(cam.position);
  _inv.copy(cam.quaternion).invert();
  return _view.applyQuaternion(_inv);
}

// Mirror PlayerVisuals.updateCamera: position then lookAt along yaw/pitch.
function driveCamera(cam: THREE.PerspectiveCamera, pos: THREE.Vector3, yaw: number, pitch: number): void {
  cam.position.copy(pos);
  cam.lookAt(
    pos.x + Math.cos(pitch) * Math.sin(yaw),
    pos.y + Math.sin(pitch),
    pos.z + Math.cos(pitch) * Math.cos(yaw),
  );
  cam.updateMatrixWorld(true);
}

describe('LG beam anchor under strafing', () => {
  it('stays welded to the gun while strafing right at 30 m/s', () => {
    const cam = new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 1000);
    const pos = new THREE.Vector3(0, 50, 0);
    const dt = 1 / 60;
    // Player moves along camera-right while keeping aim forward — the
    // exact scenario that was detaching the bolt.
    for (let f = 0; f < 120; f += 1) {
      driveCamera(cam, pos, 0, 0);
      cam.getWorldDirection(_fwd);
      const right = new THREE.Vector3().crossVectors(_fwd, new THREE.Vector3(0, 1, 0)).normalize();
      pos.addScaledVector(right, 30 * dt); // strafe at 30 m/s

      driveCamera(cam, pos, 0, 0); // camera catches up, THEN the beam welds
      const v = anchorInViewSpace(cam);
      expect(v.x).toBeCloseTo(EXPECT_X, 6);
      expect(v.y).toBeCloseTo(EXPECT_Y, 6);
      expect(v.z).toBeCloseTo(EXPECT_Z, 6);
    }
  });

  it('stays welded while strafing diagonally and turning', () => {
    const cam = new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 1000);
    const pos = new THREE.Vector3(100, 30, -40);
    const dt = 1 / 60;
    for (let f = 0; f < 180; f += 1) {
      const yaw = f * 0.01; // turning while strafing
      driveCamera(cam, pos, yaw, -0.2);
      cam.getWorldDirection(_fwd);
      const right = new THREE.Vector3().crossVectors(_fwd, new THREE.Vector3(0, 1, 0)).normalize();
      pos.addScaledVector(right, 25 * dt).addScaledVector(_fwd, 10 * dt);

      driveCamera(cam, pos, yaw + 0.01, -0.2);
      const v = anchorInViewSpace(cam);
      expect(v.x).toBeCloseTo(EXPECT_X, 6);
      expect(v.y).toBeCloseTo(EXPECT_Y, 6);
      expect(v.z).toBeCloseTo(EXPECT_Z, 6);
    }
  });

  it('anchor sits at the gun on screen, not at the eye', () => {
    const cam = new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 1000);
    const pos = new THREE.Vector3(0, 50, 0);
    driveCamera(cam, pos, 0.7, 0.1);
    lgMuzzleAnchor(cam, _anchor);
    // Must be ahead of the eye and right-of/below the optical axis —
    // if it ever collapses to eye position, the bolt spawns at your face.
    const dist = _anchor.distanceTo(cam.position);
    expect(dist).toBeGreaterThan(0.5);
    expect(dist).toBeLessThan(1.5);
  });
});
