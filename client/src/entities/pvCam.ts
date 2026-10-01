import * as THREE from 'three';
import { PlayerVisuals } from './PlayerVisuals.js';
import type { Terrain } from '../world/terrain.js';

// Camera paths: first/third-person boom, frozen (demo playback), and the
// T1/T2 observer free-fly rig — plus the feet gizmo that shares their
// terrain reads.

export function updateCamera(v: PlayerVisuals, camera: THREE.PerspectiveCamera, terrain: Terrain, cam: { pos: THREE.Vector3; yaw: number; pitch: number; thirdPerson: boolean }): void {
  const { pos, yaw, pitch, thirdPerson } = cam;
    if (thirdPerson) {
      // Spherical orbit: the boom opposes the FULL aim vector — aim down
      // and the camera swings up overhead, aim up and it drops low behind
      // you. This is what separates a chase cam from "FP moved back".
      const ax = Math.cos(pitch) * Math.sin(yaw);
      const ay = Math.sin(pitch);
      const az = Math.cos(pitch) * Math.cos(yaw);
      camera.position.set(
        pos.x - ax * PlayerVisuals.TP_BACK,
        pos.y - ay * PlayerVisuals.TP_BACK + PlayerVisuals.TP_UP,
        pos.z - az * PlayerVisuals.TP_BACK,
      );
      const groundAtCam = terrain.getHeight(camera.position.x, camera.position.z);
      if (camera.position.y < groundAtCam + 0.25) {
        camera.position.y = groundAtCam + 0.25;
      }
      // Converge on the aim point at TP_FOCUS range, not parallel gaze —
      // the slight downward tilt toward YOU is what drops the body into
      // the lower third and makes it feel like a chase cam, while the
      // crosshair still lands shots at typical engagement distances
      const f = PlayerVisuals.TP_FOCUS;
      const tx = pos.x + Math.cos(pitch) * Math.sin(yaw) * f;
      const ty = pos.y + Math.sin(pitch) * f;
      const tz = pos.z + Math.cos(pitch) * Math.cos(yaw) * f;
      camera.lookAt(tx, ty, tz);
      return;
    }
    camera.position.copy(pos);
    const groundAtCam = terrain.getHeight(camera.position.x, camera.position.z);
    if (camera.position.y < groundAtCam + 0.25) {
      camera.position.y = groundAtCam + 0.25;
    }
    // Look target from the CLAMPED camera position — if the eye got lifted
    // above the terrain while pos sits lower (dead-observer noclip), aiming
    // at pos would tilt the view pitch. yaw/pitch must mean mouse-look only.
    const tx = camera.position.x + Math.cos(pitch) * Math.sin(yaw);
    const ty = camera.position.y + Math.sin(pitch);
    const tz = camera.position.z + Math.cos(pitch) * Math.cos(yaw);
    camera.lookAt(tx, ty, tz);
  }

  // Feet marker — pinned to the terrain surface below the player
export function updateFeetMarker(v: PlayerVisuals, terrain: Terrain, pos: THREE.Vector3): void {
    v.groundGizmo.position.set(pos.x, terrain.getHeight(pos.x, pos.z) + 0.05, pos.z);
    v.groundGizmoGhost.position.copy(v.groundGizmo.position);
  }

  // Demo playback path: camera follows pos without input/physics
export function updateFrozenCamera(v: PlayerVisuals, camera: THREE.PerspectiveCamera, terrain: Terrain, pos: THREE.Vector3, yaw: number, pitch: number): void {
    updateCamera(v, camera, terrain, { pos, yaw, pitch, thirdPerson: false });
    updateFeetMarker(v, terrain, pos);
  }

  // T1/T2 observer mode while dead: you become a ghost — free mouse-look
  // plus noclip flight (WASD + Space to rise, Shift to sink) until the
  // server respawns you. No forced camera motion, so zero sim-sickness
  // risk; the player drives the view like T1's observer/Tab mode.
export function updateObserverCam(v: PlayerVisuals, dt: number, camera: THREE.PerspectiveCamera, terrain: Terrain, pos: THREE.Vector3, ...rest: [vel: THREE.Vector3, yaw: number, pitch: number, input: { forward: number; right: number; jumpHeld: boolean; shiftDown: boolean }]): void {
    const [vel, yaw, pitch, input] = rest;
    const OBSERVER_SPEED = 40; // m/s ghost-flight
    const fwd = new THREE.Vector3(
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw)
    );
    const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    pos.addScaledVector(fwd, input.forward * OBSERVER_SPEED * dt);
    pos.addScaledVector(right, input.right * OBSERVER_SPEED * dt);
    if (input.jumpHeld) pos.y += OBSERVER_SPEED * dt;
    if (input.shiftDown) pos.y -= OBSERVER_SPEED * dt;
    // Terrain collider, spectator-flavored: the floor under the EYE always
    // holds, and when the view pitches down the terrain ahead of the eye
    // matters too — the near plane is what dirt clips. Blend the look-dir
    // footprint in by sin(pitch): level flight is only clamped by ground
    // below, steep-down flight is clamped by the slope it's about to face.
    // Creature/projectile collision stays off — it's a ghost, just not a
    // dirty one.
    let groundY = terrain.getHeight(pos.x, pos.z);
    const down = Math.max(0, -Math.sin(pitch)); // pitch<0 = looking down
    if (down > 0.01) {
      const fx = Math.sin(yaw) * 1.6, fz = Math.cos(yaw) * 1.6; // ~1.6m ahead
      const sx = Math.cos(yaw) * 1.0, sz = -Math.sin(yaw) * 1.0; // flank flares
      const aheadY = Math.max(
        terrain.getHeight(pos.x + fx, pos.z + fz),
        terrain.getHeight(pos.x + fx + sx, pos.z + fz + sz),
        terrain.getHeight(pos.x + fx - sx, pos.z + fz - sz),
      );
      if (aheadY > groundY) groundY += (aheadY - groundY) * down;
    }
    const floorY = groundY + 0.6; // eye clearance — not a buried-body fight
    if (pos.y < floorY) pos.y = floorY;
    vel.set(0, 0, 0); // observer drift isn't body momentum
    updateCamera(v, camera, terrain, { pos, yaw, pitch, thirdPerson: false }); // keeps the camera above the terrain surface
  }

