import * as THREE from 'three';
import type { PlayerVisuals } from './PlayerVisuals.js';
import { aswBucket, ASW_HEX } from '../ui/hud/scoreboard.js';

// Camera boom constants live here (not on PlayerVisuals) so pvCam doesn't
// depend on PlayerVisuals at runtime - PlayerVisuals imports pvCam for
// method delegation, so a value import here was a real cycle.
export const TP_BACK = 4.2;   // boom length
export const TP_UP = 1.7;     // constant lift - keeps the body under the crosshair
export const TP_FOCUS = 180;  // camera converges on the aim point at this range
import type { Terrain } from '../world/terrain.js';

const _obTarget = new THREE.Vector3(); // observer drift target — scratch
const _fmQuat = new THREE.Quaternion();
const _fmFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _fmUp = new THREE.Vector3(0, 1, 0);

// Camera paths: first/third-person boom, frozen (demo playback), and the
// T1/T2 observer free-fly rig — plus the feet gizmo that shares their
// terrain reads.

export function updateCamera(v: PlayerVisuals, camera: THREE.PerspectiveCamera, terrain: Terrain, cam: { pos: THREE.Vector3; yaw: number; pitch: number; thirdPerson: boolean; orbit?: { yaw: number; pitch: number }; dist?: number }): void {
  const { pos, yaw, pitch, thirdPerson, orbit, dist } = cam;
    if (orbit) {
      // Middle-mouse inspect cam: boom rides the ORBIT angles (detached from
      // aim yaw/pitch) and frames the body, so spinning the view never moves
      // the crosshair. Camera sits on the far side of `pos` from the orbit
      // direction — drag left to walk the view around him.
      const back = dist ?? TP_BACK;
      const ax = Math.cos(orbit.pitch) * Math.sin(orbit.yaw);
      const ay = Math.sin(orbit.pitch);
      const az = Math.cos(orbit.pitch) * Math.cos(orbit.yaw);
      camera.position.set(
        pos.x - ax * back,
        pos.y - ay * back + TP_UP,
        pos.z - az * back,
      );
      const groundAtCam = terrain.getHeight(camera.position.x, camera.position.z);
      if (camera.position.y < groundAtCam + 0.25) {
        camera.position.y = groundAtCam + 0.25;
      }
      camera.lookAt(pos.x, pos.y - 0.4, pos.z); // chest height, not the eye
      return;
    }
    if (thirdPerson) {
      // Spherical orbit: the boom opposes the FULL aim vector — aim down
      // and the camera swings up overhead, aim up and it drops low behind
      // you. This is what separates a chase cam from "FP moved back".
      const ax = Math.cos(pitch) * Math.sin(yaw);
      const ay = Math.sin(pitch);
      const az = Math.cos(pitch) * Math.cos(yaw);
      camera.position.set(
        pos.x - ax * TP_BACK,
        pos.y - ay * TP_BACK + TP_UP,
        pos.z - az * TP_BACK,
      );
      const groundAtCam = terrain.getHeight(camera.position.x, camera.position.z);
      if (camera.position.y < groundAtCam + 0.25) {
        camera.position.y = groundAtCam + 0.25;
      }
      // Converge on the aim point at TP_FOCUS range, not parallel gaze —
      // the slight downward tilt toward YOU is what drops the body into
      // the lower third and makes it feel like a chase cam, while the
      // crosshair still lands shots at typical engagement distances
      const f = TP_FOCUS;
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

  // Feet marker — pinned to the terrain surface below the player, tinted
  // by the live ASW bucket (same classifier the scoreboard accrues with).
  // Rides getRenderedHeight too: the mesh chord sits above the heightfield
  // on slopes, and a heightfield-only pin dug the ring into the visuals.
export function updateFeetMarker(v: PlayerVisuals, terrain: Terrain, pos: THREE.Vector3, feetY = pos.y, speed = 0, skiing = false): void {
    const groundY = Math.max(terrain.getHeight(pos.x, pos.z), terrain.getRenderedHeight(pos.x, pos.z));
    v.groundGizmo.position.set(pos.x, groundY + 0.05, pos.z);
    // Tilt to the terrain normal — a flat ring's 0.7m span digs into any
    // slope the +0.05 lift can't outrun. Hugging the chord keeps depth
    // test on, so walls/bodies still occlude (no x-ray ring).
    _fmQuat.setFromUnitVectors(_fmUp, terrain.getNormal(pos.x, pos.z)).multiply(_fmFlat);
    v.groundGizmo.quaternion.copy(_fmQuat);
    (v.groundGizmo.material as THREE.MeshBasicMaterial).color.setHex(
      ASW_HEX[aswBucket(feetY - groundY, speed, skiing)]);
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
    // Ghost drift, not sprint: 12 m/s ceiling reached through an
    // exponential ramp (~0.25s to bite) and released the same way — a
    // dead cam that snaps to full speed reads as alive-and-moving.
    // `vel` doubles as the drift accumulator (the dead body's sim
    // velocity is dead weight anyway); it enters holding whatever the
    // corpse had, so a kill shove carries over and bleeds off.
    const OBSERVER_SPEED = 30;
    const fwd = new THREE.Vector3(
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw)
    );
    const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    _obTarget.set(0, 0, 0)
      .addScaledVector(fwd, input.forward)
      .addScaledVector(right, input.right);
    _obTarget.y += (input.jumpHeld ? 1 : 0) - (input.shiftDown ? 1 : 0);
    if (_obTarget.lengthSq() > 1) { _obTarget.normalize(); }
    _obTarget.multiplyScalar(OBSERVER_SPEED);
    vel.lerp(_obTarget, 1 - Math.exp(-dt / 0.25));
    pos.addScaledVector(vel, dt);
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
      const sx = Number(Math.cos(yaw)), sz = -Math.sin(yaw) * 1; // flank flares
      const aheadY = Math.max(
        terrain.getHeight(pos.x + fx, pos.z + fz),
        terrain.getHeight(pos.x + fx + sx, pos.z + fz + sz),
        terrain.getHeight(pos.x + fx - sx, pos.z + fz - sz),
      );
      if (aheadY > groundY) {groundY += (aheadY - groundY) * down;}
    }
    const floorY = groundY + 0.6; // eye clearance — not a buried-body fight
    if (pos.y < floorY) {pos.y = floorY; vel.y = Math.max(0, vel.y);} // floor holds the drift too
    updateCamera(v, camera, terrain, { pos, yaw, pitch, thirdPerson: false }); // keeps the camera above the terrain surface
  }

