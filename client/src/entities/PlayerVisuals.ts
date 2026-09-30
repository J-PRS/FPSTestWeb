import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
import { EYE_OFFSET } from '../core/config.js';
import { pickLocomotionAnim } from './locomotionAnim.js';
import type { AnimationState, PlayerModel } from './PlayerModel.js';

/**
 * First-person presentation for Player: camera follow + terrain clamp, shadow
 * blob, feet ring (+ occluded-ghost pass), dead-observer flight, and model
 * animation. Owns the meshes so Player stays about input/physics/network.
 * Mutates the player's pos/vel directly (same-object convention, like
 * MovementController) rather than returning copies.
 */
export class PlayerVisuals {
  private shadowBlob: THREE.Mesh;
  private groundGizmo: THREE.Mesh;
  private groundGizmoGhost: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    // Shadow blob — a small grid conforming to the terrain, not a flat
    // circle: on slopes a flat disc buries its uphill half inside the hill
    // and depthTest clips it. Vertices are displaced per-frame in
    // updateShadowBlob so the blob hugs the ground.
    const shadowGeo = new THREE.PlaneGeometry(1.6, 1.6, 10, 10);
    const shadowMat = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(0x000000) },
        opacity: { value: 0.4 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform float opacity;
        varying vec2 vUv;
        void main() {
          float dist = distance(vUv, vec2(0.5));
          float alpha = smoothstep(0.5, 0.2, dist) * opacity;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      // depthTest on — the blob behind a ridge must be occluded by it.
      // polygonOffset biases depth toward the camera so terrain detail
      // between grid vertices doesn't clip the blob as polygon wedges.
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    });
    this.shadowBlob = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadowBlob.rotation.x = -Math.PI / 2; // Lay flat on ground
    this.shadowBlob.renderOrder = 999; // Render after terrain
    scene.add(this.shadowBlob);

    // Feet marker — soft glowing ring flat on the terrain (reads nicer than a wireframe sphere)
    const gizmoGeo = new THREE.RingGeometry(0.28, 0.36, 32);
    const gizmoMat = new THREE.MeshBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    this.groundGizmo = new THREE.Mesh(gizmoGeo, gizmoMat);
    this.groundGizmo.rotation.x = -Math.PI / 2;
    this.groundGizmo.renderOrder = 999;
    scene.add(this.groundGizmo);
    // Ghost pass: draws only where terrain occludes the ring (GreaterDepth) —
    // on slopes the buried arc shows through dimmed instead of vanishing
    const ghostMat = new THREE.MeshBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false, depthFunc: THREE.GreaterDepth });
    this.groundGizmoGhost = new THREE.Mesh(gizmoGeo, ghostMat);
    this.groundGizmoGhost.rotation.x = -Math.PI / 2;
    this.groundGizmoGhost.renderOrder = 998;
    scene.add(this.groundGizmoGhost);
  }

  // Third-person chase cam — Tribes Ascend style: camera backs out along the
  // horizontal look axis and sits a little high, aim stays at screen center,
  // and the body renders in the lower third. No shoulder offset.
  private static readonly TP_BACK = 4.2;   // boom length
  private static readonly TP_UP = 1.7;     // constant lift — keeps the body under the crosshair
  private static readonly TP_FOCUS = 180;  // camera converges on the aim point at this range

  // Update camera to final position — never let it go below the terrain
  // surface, or steep slopes put the eye inside the mesh and you see the
  // interior of the mountain.
  updateCamera(camera: THREE.PerspectiveCamera, terrain: Terrain, pos: THREE.Vector3, yaw: number, pitch: number, thirdPerson = false): void {
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
  updateFeetMarker(terrain: Terrain, pos: THREE.Vector3): void {
    this.groundGizmo.position.set(pos.x, terrain.getHeight(pos.x, pos.z) + 0.05, pos.z);
    this.groundGizmoGhost.position.copy(this.groundGizmo.position);
  }

  // Demo playback path: camera follows pos without input/physics
  updateFrozenCamera(camera: THREE.PerspectiveCamera, terrain: Terrain, pos: THREE.Vector3, yaw: number, pitch: number): void {
    this.updateCamera(camera, terrain, pos, yaw, pitch);
    this.updateFeetMarker(terrain, pos);
  }

  // T1/T2 observer mode while dead: you become a ghost — free mouse-look
  // plus noclip flight (WASD + Space to rise, Shift to sink) until the
  // server respawns you. No forced camera motion, so zero sim-sickness
  // risk; the player drives the view like T1's observer/Tab mode.
  updateObserverCam(dt: number, camera: THREE.PerspectiveCamera, terrain: Terrain, pos: THREE.Vector3, ...rest: [vel: THREE.Vector3, yaw: number, pitch: number, input: { forward: number; right: number; jumpHeld: boolean; shiftDown: boolean }]): void {
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
    this.updateCamera(camera, terrain, pos, yaw, pitch); // keeps the camera above the terrain surface
  }

  private shadowPosAttr: THREE.BufferAttribute | null = null;

  updateShadowBlob(terrain: Terrain, pos: THREE.Vector3): void {
    const groundY = terrain.getHeight(pos.x, pos.z);
    // Conform the grid to the terrain — local (x,y) → world (x,−y), local
    // z → world up, so each vertex samples its own ground height.
    const attr = this.shadowPosAttr
      ?? (this.shadowPosAttr = this.shadowBlob.geometry.getAttribute('position') as THREE.BufferAttribute);
    for (let i = 0; i < attr.count; i++) {
      attr.setZ(i, terrain.getHeight(pos.x + attr.getX(i), pos.z - attr.getY(i)) + 0.05);
    }
    attr.needsUpdate = true;
    this.shadowBlob.position.set(pos.x, 0, pos.z);
    // Fade shadow smoothly when in air
    const airHeight = pos.y - groundY;
    const opacity = airHeight > 2.0
      ? Math.max(0, 0.4 * (1 - (airHeight - 2.0) / 6.0))
      : 0.4;
    (this.shadowBlob.material as THREE.ShaderMaterial).uniforms.opacity.value = opacity;
  }

  // Returns the new jumpAnimTimer (the one piece of player state the
  // animation owns — set back on the Player by the caller)
  // Continuous airtime for the airborne-anim gate — micro-frames over
  // bumps don't count as jumping.
  private airT = 0;
  private lastShootT = 0;

  updateModelAnim(model: PlayerModel | null, pos: THREE.Vector3, ...rest: [yaw: number, pitch: number, jumpAnimTimer: number, speed: number, dt: number, onGround: boolean, jetting?: boolean, vel?: THREE.Vector3, skiing?: boolean, shootT?: number]): number {
    const [yaw, pitch, jumpAnimTimer0, speed, dt, onGround, jetting = false, vel, skiing, shootT = 0] = rest;
    let jumpAnimTimer = jumpAnimTimer0;
    if (!model) return jumpAnimTimer;
    if (jumpAnimTimer > 0) {
      jumpAnimTimer = Math.max(0, jumpAnimTimer - dt);
    }
    // Airborne takes priority over locomotion — not just the jump
    // transition: sustained jetting/falling at speed reads as "run on
    // air" under the pure speed pick. A powered climb gets the jet pose.
    // Sustained-air gate: cresting a bump drops onGround for a frame or
    // two — treating that as airborne swap-tucks the model at running
    // speed ("sliding while walking"). Only real airtime poses as jump.
    this.airT = onGround ? 0 : this.airT + dt;
    const airborne = this.airT > 0.12 || (!onGround && jumpAnimTimer > 0);
    // Firing snaps the body into the armed pose — if the gun was down for
    // ANY reason (belt lower, flinch, holster), a trigger pull is the
    // moment it must read as aimed. Airborne keeps the jump/jet pose;
    // the arm-layer aims up there regardless.
    const animState: AnimationState = airborne
      ? (jetting ? 'jet' : 'jump')
      : shootT > 0
        ? 'shoot'
        : pickLocomotionAnim(model['currentState'] as AnimationState, speed, skiing);
    // Auto-fire re-arms shootT while 'shoot' still owns the state —
    // force replays the clip from its aimed frame each pull, else only
    // the first shot of a held trigger animates.
    if (animState === 'shoot' && shootT > this.lastShootT) model.forceAnimationState('shoot');
    else model.setAnimationState(animState);
    this.lastShootT = shootT;
    this.applyLocomotionLean(model, animState, yaw, speed, vel, jetting);
    // pos is eye height — the model plants its feet 1.8m below
    model.setPosition(pos.x, pos.y - EYE_OFFSET, pos.z);
    model.setRotation(yaw, pitch);
    model.update(dt);
    return jumpAnimTimer;
  }

  /** Backpedal clip flip + jet tilt/strafe roll. vel is real velocity,
   *  not an input echo — it stays honest through collisions/knockback. */
  private applyLocomotionLean(model: PlayerModel, animState: AnimationState, yaw: number, speed: number, vel: THREE.Vector3 | undefined, jetting: boolean): void {
    let fwd = 0, side = 0;
    if (vel && speed > 1) {
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      fwd = vel.x * sin + vel.z * cos;
      side = vel.x * cos - vel.z * sin;
    }
    model.setLocomotionReversed(
      (animState === 'walk' || animState === 'run') && fwd < -0.6 * speed && -fwd > Math.abs(side));
    // Same directional jet tilt remotes get — your own body is visible
    // in third-person, so it should lean into the thrust too. Grounded
    // strafing gets a smaller version of the same roll — without it the
    // forward cycle's footwork reads as moonwalking sideways.
    if (jetting && vel) {
      model.setBodyLean(
        Math.max(-0.45, Math.min(0.45, fwd * 0.022)),
        Math.max(-0.4, Math.min(0.4, -side * 0.02)));
    } else {
      const strafing = Math.abs(side) > 0.6 * speed && Math.abs(side) > Math.abs(fwd) * 0.8;
      model.setBodyLean(0, strafing ? Math.max(-0.3, Math.min(0.3, -side * 0.02)) : 0);
    }
  }
}
