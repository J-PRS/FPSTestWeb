import * as pc from 'playcanvas';
import { Terrain } from './Terrain.js';

export class PlayerController {
  entity: pc.Entity;
  canvas: HTMLCanvasElement;
  terrain: Terrain;
  moveSpeed: number;
  jumpForce: number;
  mouseSensitivity: number;
  invertY: boolean;
  velocity: pc.Vec3;
  onGround: boolean;
  yaw: number;
  pitch: number;
  keys: {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    jump: boolean;
  };

  constructor(entity: pc.Entity, canvas: HTMLCanvasElement, terrain: Terrain) {
    this.entity = entity;
    this.canvas = canvas;
    this.terrain = terrain;
    
    // Movement settings
    this.moveSpeed = 10.0;
    this.jumpForce = 8.0;
    this.mouseSensitivity = 0.002;
    this.invertY = true;
    
    // State
    this.velocity = new pc.Vec3(0, 0, 0);
    this.onGround = false;
    this.yaw = 0;
    this.pitch = 0;
    
    // Input state
    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      jump: false
    };
    
    this.setupInput();
  }
  
  setupInput(): void {
    // Keyboard input
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    
    // Mouse look
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    
    // Pointer lock
    this.canvas.addEventListener('click', () => {
      this.canvas.requestPointerLock();
    });
  }
  
  onKeyDown(e: KeyboardEvent): void {
    switch(e.code) {
      case 'KeyW': this.keys.forward = true; break;
      case 'KeyS': this.keys.backward = true; break;
      case 'KeyA': this.keys.left = true; break;
      case 'KeyD': this.keys.right = true; break;
      case 'Space': this.keys.jump = true; break;
    }
  }
  
  onKeyUp(e: KeyboardEvent): void {
    switch(e.code) {
      case 'KeyW': this.keys.forward = false; break;
      case 'KeyS': this.keys.backward = false; break;
      case 'KeyA': this.keys.left = false; break;
      case 'KeyD': this.keys.right = false; break;
      case 'Space': this.keys.jump = false; break;
    }
  }
  
  onMouseMove(e: MouseEvent): void {
    if (document.pointerLockElement === this.canvas) {
      this.yaw -= e.movementX * this.mouseSensitivity;
      const yDelta = this.invertY ? 1 : -1;
      this.pitch += yDelta * e.movementY * this.mouseSensitivity;
      
      // Clamp pitch
      this.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.pitch));
    }
  }
  
  update(dt: number): void {
    // Calculate movement direction
    const forward = new pc.Vec3(
      -Math.sin(this.yaw),
      0,
      -Math.cos(this.yaw)
    ).normalize();
    
    const right = new pc.Vec3(
      Math.cos(this.yaw),
      0,
      -Math.sin(this.yaw)
    ).normalize();
    
    // Apply input
    const moveDir = new pc.Vec3(0, 0, 0);
    if (this.keys.forward) moveDir.add(forward);
    if (this.keys.backward) moveDir.sub(forward);
    if (this.keys.left) moveDir.sub(right);
    if (this.keys.right) moveDir.add(right);
    
    if (moveDir.length() > 0) {
      moveDir.normalize();
    }
    
    // Apply movement
    this.velocity.x = moveDir.x * this.moveSpeed;
    this.velocity.z = moveDir.z * this.moveSpeed;
    
    // Jump
    if (this.keys.jump && this.onGround) {
      this.velocity.y = this.jumpForce;
      this.onGround = false;
    }
    
    // Gravity
    this.velocity.y -= 20.0 * dt;
    
    // Update position
    const newPos = this.entity.getPosition().clone();
    newPos.x += this.velocity.x * dt;
    newPos.y += this.velocity.y * dt;
    newPos.z += this.velocity.z * dt;
    
    // Terrain collision
    const terrainHeight = this.terrain.getHeight(newPos.x, newPos.z);
    const groundY = terrainHeight + 1.7; // Player eye height
    
    if (newPos.y < groundY) {
      newPos.y = groundY;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
    
    this.entity.setPosition(newPos);
    
    // Update camera rotation
    const camera = this.entity.findByName('Camera');
    if (camera) {
      camera.setEulerAngles(this.pitch * pc.math.RAD_TO_DEG, this.yaw * pc.math.RAD_TO_DEG, 0);
    }
  }
  
  getPosition(): pc.Vec3 {
    return this.entity.getPosition();
  }
  
  getRotation(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }
}
