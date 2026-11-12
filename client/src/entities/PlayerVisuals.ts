import * as THREE from 'three';
import * as pvCam from './pvCam.js';

import type { Terrain } from '../world/terrain.js';
import { EYE_OFFSET } from '../core/config.js';
import { pickLocomotionAnim } from './locomotionAnim.js';
import type { AnimationState, PlayerModel } from './PlayerModel.js';
import { BallTrailDots } from '../effects/ballTrails.js';
import { UNGRADE_GLSL } from '../core/gradeGlsl.js';

const _airP = new THREE.Vector3();
const _airTint = new THREE.Color(0.75, 0.85, 1);

/**
 * First-person presentation for Player: camera follow + terrain clamp, shadow
 * blob, feet ring (+ occluded-ghost pass), dead-observer flight, and model
 * animation. Owns the meshes so Player stays about input/physics/network.
 * Mutates the player's pos/vel directly (same-object convention, like
 * MovementController) rather than returning copies.
 */
export class PlayerVisuals {
  private shadowBlob: THREE.Mesh;
  groundGizmo: THREE.Mesh;
  // Same faint air trail remotes get — your own arc is only readable in
  // third person, so emission gates on that flag (dots spawn behind you).
  private airTrail: BallTrailDots | null = null;

  constructor(private scene: THREE.Scene) {
    // Shadow blob — a small grid conforming to the terrain, not a flat
    // circle: on slopes a flat disc buries its uphill half inside the hill
    // and depthTest clips it. Vertices are displaced per-frame in
    // updateShadowBlob so the blob hugs the ground.
    const shadowGeo = new THREE.PlaneGeometry(1.6, 1.6, 10, 10);
    const shadowMat = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(0x00_00_00) },
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
        ${UNGRADE_GLSL}
        void main() {
          float dist = distance(vUv, vec2(0.5));
          float alpha = smoothstep(0.5, 0.2, dist) * opacity;
          gl_FragColor = vec4(ungradeColor(color), alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
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
    // Ground decal — only needs to land after terrain (-2); at 999 it
    // painted dark over explosion glow and damage numbers.
    this.shadowBlob.renderOrder = 0;
    scene.add(this.shadowBlob);

    // Feet marker — soft glowing ring flat on the terrain (reads nicer than a wireframe sphere)
    const gizmoGeo = new THREE.RingGeometry(0.28, 0.36, 48);
    gizmoGeo.rotateX(-Math.PI / 2); // verts live in XZ; pvCam conforms Y per frame
    // depthTest ON — the pin rides getRenderedHeight (the real mesh
    // chord) now, so depthTest:false only made it paint through walls and
    // players. polygonOffset buys the same slope-edge slack the shadow
    // blob gets, where the ring's span outruns the +0.05 lift.
    const gizmoMat = new THREE.MeshBasicMaterial({ color: 0x66_FF_CC, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, depthTest: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.groundGizmo = new THREE.Mesh(gizmoGeo, gizmoMat);
    // Same slot as the shadow blob — after terrain, before overlays.
    this.groundGizmo.renderOrder = 0;
    scene.add(this.groundGizmo);
  }

  // Third-person chase cam — Tribes Ascend style: camera backs out along the
  // horizontal look axis and sits a little high, aim stays at screen center,
  // and the body renders in the lower third. No shoulder offset.
  // Camera boom constants moved to pvCam.ts (see pvCam.ts header) to break
  // the PlayerVisuals <-> pvCam cycle. Re-exported here for callers that
  // referenced PlayerVisuals.TP_*.
  static readonly TP_BACK = pvCam.TP_BACK;
  static readonly TP_UP = pvCam.TP_UP;
  static readonly TP_FOCUS = pvCam.TP_FOCUS;

  // Update camera to final position — never let it go below the terrain
  // surface, or steep slopes put the eye inside the mesh and you see the
  // interior of the mountain.
  updateCamera(camera: THREE.PerspectiveCamera, terrain: Terrain, cam: { pos: THREE.Vector3; yaw: number; pitch: number; thirdPerson?: boolean; orbit?: { yaw: number; pitch: number }; dist?: number }): void {
    pvCam.updateCamera(this, camera, terrain, Object.assign({}, {thirdPerson: false}, cam));
  }

  updateFeetMarker(terrain: Terrain, pos: THREE.Vector3, ...rest: [feetY?: number, speed?: number, skiing?: boolean]): void { pvCam.updateFeetMarker(this, terrain, pos, ...rest); }

  updateFrozenCamera(camera: THREE.PerspectiveCamera, terrain: Terrain, pos: THREE.Vector3, yaw: number, pitch: number): void {
    pvCam.updateFrozenCamera(this, camera, terrain, pos, yaw, pitch);
  }

  updateObserverCam(dt: number, camera: THREE.PerspectiveCamera, terrain: Terrain, pos: THREE.Vector3, ...rest: [vel: THREE.Vector3, yaw: number, pitch: number, input: { forward: number; right: number; jumpHeld: boolean; shiftDown: boolean }]): void {
    pvCam.updateObserverCam(this, dt, camera, terrain, pos, ...rest);
  }

  private shadowPosAttr: THREE.BufferAttribute | null = null;

  updateShadowBlob(terrain: Terrain, pos: THREE.Vector3): void {
    const groundY = terrain.getHeight(pos.x, pos.z);
    // Conform the grid to the terrain — local (x,y) → world (x,−y), local
    // z → world up, so each vertex samples its own ground height.
    const attr = this.shadowPosAttr
      ?? (this.shadowPosAttr = this.shadowBlob.geometry.getAttribute('position') as THREE.BufferAttribute);
    for (let i = 0; i < attr.count; i += 1) {
      const wx = pos.x + attr.getX(i), wz = pos.z - attr.getY(i);
      // Clear the rendered chord too, not just the heightfield: the 5m
      // mesh bridges mid-cell gullies, and depthTest clips a blob that
      // dips under the chord even though it hugs the true heightmap.
      attr.setZ(i, Math.max(terrain.getHeight(wx, wz), terrain.getRenderedHeight(wx, wz)) + 0.12);
    }
    attr.needsUpdate = true;
    this.shadowBlob.position.set(pos.x, 0, pos.z);
    // Fade shadow smoothly when in air
    const airHeight = pos.y - groundY;
    const opacity = airHeight > 2
      ? Math.max(0, 0.4 * (1 - (airHeight - 2) / 6))
      : 0.4;
    (this.shadowBlob.material as THREE.ShaderMaterial).uniforms.opacity.value = opacity;
  }

  // Returns the new jumpAnimTimer (the one piece of player state the
  // animation owns — set back on the Player by the caller)
  // Continuous airtime for the airborne-anim gate — micro-frames over
  // bumps don't count as jumping.
  private airT = 0;
  private lastShootT = 0;

  /** Faint innate air trail — the same arc read remotes get; gated to third person since your own dots would just bloom behind the camera. */
  private tickAirTrail(dt: number, pos: THREE.Vector3, vel: THREE.Vector3 | undefined, emit: boolean): void {
    // Same correction-sweep guard as ballVisual — a smoothed correction
    // deposits dots along its path, so emit only on real travel.
    const moved = this._airLastInit ? this._airLast.distanceTo(pos) : 0;
    const travel = Math.max(1e-4, (vel?.length() ?? 0) * dt);
    const correcting = moved > Math.max(6, travel * 4);
    if (emit && !correcting) {
      if (!this.airTrail) {this.airTrail = new BallTrailDots(this.scene, { opacity: 0.32, sizeMul: 0.45, interval: 0.05, maxDots: 18 });}
      _airP.copy(pos); _airP.y -= 0.7;
      this.airTrail.emit(dt, _airP, vel ?? _airP, 0.4, _airTint);
    }
    this._airLast.copy(pos); this._airLastInit = true;
    this.airTrail?.fade(dt);
  }
  private _airLast = new THREE.Vector3();
  private _airLastInit = false;

  updateModelAnim(model: PlayerModel | null, pos: THREE.Vector3, ...rest: [yaw: number, pitch: number, jumpAnimTimer: number, speed: number, dt: number, onGround: boolean, jetting?: boolean, vel?: THREE.Vector3, skiing?: boolean, shootT?: number, thirdPerson?: boolean, eyeOffset?: number, throwT?: number]): number {
    const [yaw, pitch, jumpAnimTimer0, speed, dt, onGround, jetting = false, vel, skiing, shootT = 0, thirdPerson = false, eyeOff = EYE_OFFSET, throwT = 0] = rest;
    let jumpAnimTimer = jumpAnimTimer0;
    if (!model) { this.tickAirTrail(dt, pos, undefined, false); return jumpAnimTimer; }
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
    this.tickAirTrail(dt, pos, vel, thirdPerson && airborne && speed > 6);
    // Firing snaps the body into the armed pose — if the gun was down for
    // ANY reason (belt lower, flinch, holster), a trigger pull is the
    // moment it must read as aimed. Airborne keeps the jump/jet pose;
    // the arm-layer aims up there regardless.
    const animState = this.pickAnimState(model, airborne, jetting, shootT, speed, skiing, throwT);
    // Each fresh trigger pull (shootT rising) kicks the gun — the recoil/
    // flash runs for EVERY shot including the local third-person model,
    // which previously got no fire feedback at all.
    this.applyShootKick(model, animState, shootT);
    this.applyLocomotionLean(model, animState, yaw, speed, vel, jetting);
    // pos is eye height — the model plants its feet eyeOff below it
    // (per armor class: heavy stands 2.5m, light 1.8m).
    model.setPosition(pos.x, pos.y - eyeOff, pos.z);
    model.setRotation(yaw, pitch);
    model.update(dt);
    return jumpAnimTimer;
  }

  /** Firing snaps the body into the armed pose — if the gun was down for
   *  ANY reason (belt lower, flinch, holster), a trigger pull is the
   *  moment it must read as aimed. The mannequin's fire feedback is the
   *  procedural recoil + muzzle flash under the always-on aim layer —
   *  the Pistol_Shoot clip only flickers the arms off-aim, so it never
   *  owns the state. */
  private pickAnimState(model: PlayerModel, airborne: boolean, jetting: boolean, shootT: number, speed: number, skiing?: boolean, throwT = 0): AnimationState {
    // A belt/deploy swing outranks EVERYTHING — airborne most of all:
    // in-flight tosses are the common case, and jet/jump + the aim layer
    // used to swallow the swing entirely.
    if (throwT > 0) {return 'throw';}
    if (airborne) {return jetting ? 'jet' : 'jump';}
    if (shootT > 0 && model.variant !== 'mannequin') {return 'shoot';}
    return pickLocomotionAnim(model['currentState'] as AnimationState, speed, skiing);
  }

  private applyShootKick(model: PlayerModel, animState: AnimationState, shootT: number): void {
    if (shootT > this.lastShootT) {
      model.fire();
      // Enter the shoot state once — re-forcing it every shot restarts the
      // oneshot clip, and at fast cadences the fadeIn/fadeOut pair cycles
      // the arms through the unarmed grip mid-volley. Sustained fire keeps
      // the armed clip asserted; only the procedural kick pulses per shot.
      if (animState === 'shoot' && model.animationState !== 'shoot') {model.forceAnimationState('shoot');}
      else {model.setAnimationState(animState);}
    } else {
      model.setAnimationState(animState);
    }
    this.lastShootT = shootT;
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
    // Dedicated 8-dir clips when the KevDev bake landed — otherwise the
    // reverse-playback backpedal trick covers backward motion.
    const dedicated = model.setLocomotionVector(fwd, side);
    if (!dedicated) {model.setLocomotionReversed(
      (animState === 'walk' || animState === 'run') && fwd < -0.6 * speed && -fwd > Math.abs(side));}
    // Same directional jet tilt remotes get — your own body is visible
    // in third-person, so it should lean into the thrust too. Grounded
    // strafing gets a smaller version of the same roll — without it the
    // forward cycle's footwork reads as moonwalking sideways.
    if (jetting && vel) {
      model.setBodyLean(
        Math.max(-0.45, Math.min(0.45, fwd * 0.022)),
        Math.max(-0.4, Math.min(0.4, -side * 0.02)));
    } else {
      const strafing = !dedicated && Math.abs(side) > 0.6 * speed && Math.abs(side) > Math.abs(fwd) * 0.8;
      model.setBodyLean(0, strafing ? Math.max(-0.3, Math.min(0.3, -side * 0.02)) : 0);
    }
  }
}
