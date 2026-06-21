import * as THREE from 'three';
import type { Terrain } from './Terrain';

const WALK_SPEED   = 12.0;
const JUMP_IMPULSE = 11.0;
const GRAVITY      = -22.0;
const PLAYER_HEIGHT = 1.8;
const SENSITIVITY  = 0.002;

export class Player {
  camera: THREE.PerspectiveCamera;
  private pos = new THREE.Vector3(250, 200, 250);
  private vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private onGround = false;
  private locked = false;

  // Input
  private keys: Set<string> = new Set();

  constructor(_scene: THREE.Scene, terrain: Terrain) {
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 3000);

    // Keyboard
    window.addEventListener('keydown', e => this.keys.add(e.code));
    window.addEventListener('keyup',   e => this.keys.delete(e.code));

    // Mouse look
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.yaw   -= e.movementX * SENSITIVITY;
      this.pitch -= e.movementY * SENSITIVITY;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    });

    this.pos.y = terrain.getHeight(250, 250) + 50;
  }

  setPointerLocked(locked: boolean) { this.locked = locked; }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, terrain: Terrain) {
    // Gravity
    this.vel.y += GRAVITY * dt;

    // Movement direction from yaw only (no pitch tilt on movement)
    const fw = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    let mx = 0, mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp'))    mz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown'))  mz -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft'))  mx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;

    const move = fw.clone().multiplyScalar(mz).addScaledVector(right, mx);
    if (move.length() > 0) {
      move.normalize().multiplyScalar(WALK_SPEED);
      this.vel.x = move.x;
      this.vel.z = move.z;
    } else {
      this.vel.x *= Math.pow(0.05, dt);
      this.vel.z *= Math.pow(0.05, dt);
    }

    // Jump
    if ((this.keys.has('Space')) && this.onGround) {
      this.vel.y = JUMP_IMPULSE;
      this.onGround = false;
    }

    // Integrate position
    this.pos.addScaledVector(this.vel, dt);

    // Terrain collision
    const groundY = terrain.getHeight(this.pos.x, this.pos.z) + PLAYER_HEIGHT;
    if (this.pos.y <= groundY) {
      this.pos.y = groundY;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // Apply camera
    this.camera.position.copy(this.pos);
    this.camera.position.y += 0; // eye already at head height
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  getPosition() { return this.pos.clone(); }
}
