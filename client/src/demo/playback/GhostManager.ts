import * as THREE from 'three';
import { DemoFrame } from '../types/DemoFrame.js';
import { Interpolator, InterpolationMode, Keyframe } from './Interpolator.js';

/**
 * Ghost object for replay visualization.
 * Represents a player or entity during demo playback.
 */
export class GhostObject {
  private mesh: THREE.Object3D;
  private isActive: boolean = false;

  constructor(scene: THREE.Scene, geometry?: THREE.BufferGeometry, material?: THREE.Material) {
    // Create ghost mesh (simple capsule by default)
    const ghostGeometry = geometry || new THREE.CapsuleGeometry(0.5, 1.8, 4, 8);
    const ghostMaterial = material || new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      transparent: true,
      opacity: 0.5,
      wireframe: true,
    });

    this.mesh = new THREE.Mesh(ghostGeometry, ghostMaterial);
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /**
   * Update ghost position and rotation.
   */
  update(position: THREE.Vector3, rotation: THREE.Quaternion): void {
    this.mesh.position.copy(position);
    this.mesh.quaternion.copy(rotation);
  }

  /**
   * Set ghost visibility.
   */
  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
    this.isActive = visible;
  }

  /**
   * Check if ghost is active.
   */
  getIsActive(): boolean {
    return this.isActive;
  }

  /**
   * Get the ghost mesh.
   */
  getMesh(): THREE.Object3D {
    return this.mesh;
  }

  /**
   * Destroy ghost and remove from scene.
   */
  destroy(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    if (this.mesh instanceof THREE.Mesh) {
      this.mesh.geometry.dispose();
      if (Array.isArray(this.mesh.material)) {
        this.mesh.material.forEach((m) => m.dispose());
      } else {
        this.mesh.material.dispose();
      }
    }
  }
}

/**
 * Manages ghost objects for demo playback.
 * Handles creation, update, and cleanup of replay entities.
 */
export class GhostManager {
  private scene: THREE.Scene;
  private ghosts: Map<string, GhostObject> = new Map();
  private interpolationMode: InterpolationMode = InterpolationMode.Linear;
  private gravity: number = -20.0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Create a ghost object.
   * @param id - Unique identifier for the ghost
   * @param geometry - Optional custom geometry
   * @param material - Optional custom material
   */
  createGhost(id: string, geometry?: THREE.BufferGeometry, material?: THREE.Material): GhostObject {
    if (this.ghosts.has(id)) {
      console.warn(`[GhostManager] Ghost ${id} already exists, reusing`);
      return this.ghosts.get(id)!;
    }

    const ghost = new GhostObject(this.scene, geometry, material);
    this.ghosts.set(id, ghost);
    return ghost;
  }

  /**
   * Get a ghost object by ID.
   */
  getGhost(id: string): GhostObject | undefined {
    return this.ghosts.get(id);
  }

  /**
   * Remove a ghost object.
   */
  removeGhost(id: string): void {
    const ghost = this.ghosts.get(id);
    if (ghost) {
      ghost.destroy(this.scene);
      this.ghosts.delete(id);
    }
  }

  /**
   * Remove all ghost objects.
   */
  removeAllGhosts(): void {
    for (const [id, ghost] of this.ghosts) {
      ghost.destroy(this.scene);
    }
    this.ghosts.clear();
  }

  /**
   * Update a ghost using interpolation between frames.
   * @param id - Ghost ID
   * @param frames - Array of demo frames
   * @param time - Current playback time
   */
  updateGhostFromFrames(id: string, frames: DemoFrame[], time: number): void {
    const ghost = this.ghosts.get(id);
    if (!ghost) {
      return;
    }

    // Convert frames to keyframes
    const keyframes: Keyframe[] = frames.map((frame) => ({
      timestamp: frame.timestamp,
      position: frame.position.clone(),
      rotation: frame.rotation.clone(),
      velocity: frame.velocity.clone(),
    }));

    // Interpolate
    const result = Interpolator.interpolate(keyframes, time, this.interpolationMode, this.gravity);

    if (result) {
      ghost.update(result.position, result.rotation);
      ghost.setVisible(true);
    }
  }

  /**
   * Update a ghost directly from a frame.
   * @param id - Ghost ID
   * @param frame - Demo frame
   */
  updateGhostFromFrame(id: string, frame: DemoFrame): void {
    const ghost = this.ghosts.get(id);
    if (!ghost) {
      return;
    }

    ghost.update(frame.position, frame.rotation);
    ghost.setVisible(true);
  }

  /**
   * Set interpolation mode for all ghosts.
   */
  setInterpolationMode(mode: InterpolationMode): void {
    this.interpolationMode = mode;
  }

  /**
   * Set gravity for parabolic interpolation.
   */
  setGravity(gravity: number): void {
    this.gravity = gravity;
  }

  /**
   * Get the number of active ghosts.
   */
  getGhostCount(): number {
    return this.ghosts.size;
  }

  /**
   * Get all ghost IDs.
   */
  getGhostIds(): string[] {
    return Array.from(this.ghosts.keys());
  }
}
