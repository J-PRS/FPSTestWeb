import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
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
    // Simple shadow blob for first-person view with soft edges
    const shadowGeo = new THREE.CircleGeometry(0.8, 32);
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
      // depthTest on — the blob behind a ridge must be occluded by it
      depthTest: true
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

  // Update camera to final position — never let it go below the terrain
  // surface, or steep slopes put the eye inside the mesh and you see the
  // interior of the mountain.
  updateCamera(camera: THREE.PerspectiveCamera, terrain: Terrain, pos: THREE.Vector3, yaw: number, pitch: number): void {
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
  updateObserverCam(dt: number, camera: THREE.PerspectiveCamera, terrain: Terrain, pos: THREE.Vector3, vel: THREE.Vector3, yaw: number, pitch: number, input: { forward: number; right: number; jumpHeld: boolean; shiftDown: boolean }): void {
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
    // Ghost can fly anywhere but not under the floor — otherwise the camera
    // clamp fights the buried body every frame
    const groundY = terrain.getHeight(pos.x, pos.z) + 0.25;
    if (pos.y < groundY) pos.y = groundY;
    vel.set(0, 0, 0); // observer drift isn't body momentum
    this.updateCamera(camera, terrain, pos, yaw, pitch); // keeps the camera above the terrain surface
  }

  updateShadowBlob(terrain: Terrain, pos: THREE.Vector3): void {
    const groundY = terrain.getHeight(pos.x, pos.z);
    this.shadowBlob.position.set(pos.x, groundY + 0.05, pos.z); // slightly above ground to prevent z-fighting
    // Fade shadow smoothly when in air
    const airHeight = pos.y - groundY;
    const opacity = airHeight > 2.0
      ? Math.max(0, 0.4 * (1 - (airHeight - 2.0) / 6.0))
      : 0.4;
    (this.shadowBlob.material as THREE.ShaderMaterial).uniforms.opacity.value = opacity;
  }

  // Returns the new jumpAnimTimer (the one piece of player state the
  // animation owns — set back on the Player by the caller)
  updateModelAnim(model: PlayerModel | null, pos: THREE.Vector3, yaw: number, pitch: number, jumpAnimTimer: number, speed: number, dt: number): number {
    if (!model) return jumpAnimTimer;
    if (jumpAnimTimer > 0) {
      jumpAnimTimer = Math.max(0, jumpAnimTimer - dt);
    }
    // Jump animation takes priority over locomotion
    const animState: AnimationState = jumpAnimTimer > 0
      ? 'jump'
      : pickLocomotionAnim(model['currentState'] as AnimationState, speed);
    model.setAnimationState(animState);
    model.setPosition(pos.x, pos.y, pos.z);
    model.setRotation(yaw, pitch);
    model.update(dt);
    return jumpAnimTimer;
  }
}
