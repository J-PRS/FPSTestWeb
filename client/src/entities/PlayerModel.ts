import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { PLAYER_RADIUS, CAPSULE_CYLINDER_HEIGHT, CAPSULE_CENTER_Y } from '../core/config.js';

import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('PlayerModel');

export type AnimationState = 'idle' | 'walk' | 'run' | 'jump' | 'death';

export class PlayerModel {
  private scene: THREE.Scene;
  private model: THREE.Group | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private animations: Map<string, THREE.AnimationAction> = new Map();
  private currentAction: THREE.AnimationAction | null = null;
  private currentState: AnimationState = 'idle';
  private colliderGizmo: THREE.Mesh | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    
    return new Promise((resolve, reject) => {
      loader.load(
        '/assets/models/RobotExpressive.glb',
        (gltf) => {
          this.model = gltf.scene;
          
          // Log model bounding box for hitbox calibration
          const box = new THREE.Box3().setFromObject(this.model);
          const size = box.getSize(new THREE.Vector3());
          const min = box.min;
          const max = box.max;
          logger.debug(`Model bounding box: size=(${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)}) min=(${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}) max=(${max.x.toFixed(2)},${max.y.toFixed(2)},${max.z.toFixed(2)})`);
          
          // Enable shadow casting
          this.model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          
          // Scale and rotate to match our coordinate system
          // Model bounding box at scale 1.0: x: 3.2, y: 4.8, z: 3.2
          // At scale 0.5: x: 1.6, y: 2.4, z: 1.6
          // Hitbox: radius 0.8 (width 1.6), height 2.0
          // Scale factor 0.5 matches width, but model is taller (2.4 vs 2.0)
          // RobotExpressive.glb origin is at feet (y=0), not center
          this.model.scale.setScalar(0.5);
          this.model.rotation.y = Math.PI; // Face forward
          // No Y offset needed — model origin is already at feet
          
          // Set up animation mixer
          this.mixer = new THREE.AnimationMixer(this.model);
          
          // Store animations with mapping
          gltf.animations.forEach((clip) => {
            const action = this.mixer!.clipAction(clip);
            this.animations.set(clip.name, action);
          });
          
          logger.debug('Loaded animations:', Array.from(this.animations.keys()));
          
          // Start with idle
          this.playAnimation('Idle');
          
          this.scene.add(this.model);
          console.log(`[PlayerModel] MODEL ADDED to scene (scene children: ${this.scene.children.length})`);

          // Create collider gizmo (wireframe capsule for hitbox visualization)
          // Uses same constants as collision detection — single source of truth in config.ts
          // CapsuleGeometry(radius, cylinderHeight, ...) — cylinderHeight excludes hemispheres
          // Model is scaled by 0.5, so divide by scale to get correct world size
          const colliderGeo = new THREE.CapsuleGeometry(PLAYER_RADIUS / 0.5, CAPSULE_CYLINDER_HEIGHT / 0.5, 4, 16);
          const colliderMat = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
            transparent: true,
            opacity: 0.3,
            depthTest: false // Always render on top
          });
          this.colliderGizmo = new THREE.Mesh(colliderGeo, colliderMat);
          // Capsule center is at feet + CAPSULE_CENTER_Y (half PLAYER_HEIGHT)
          // Model origin is at feet, model is scaled by 0.5
          // So local y = CAPSULE_CENTER_Y / 0.5
          this.colliderGizmo.position.y = CAPSULE_CENTER_Y / 0.5;
          this.colliderGizmo.renderOrder = 999; // Render last (on top)
          this.colliderGizmo.visible = true; // Ensure it's visible
          this.model.add(this.colliderGizmo); // Add as child of model so it moves with it
          console.log(`[PlayerModel] COLLIDER GIZMO ADDED to model (scene children: ${this.scene.children.length})`);

          resolve();
        },
        (xhr) => {
          logger.debug(`Loading: ${(xhr.loaded / xhr.total * 100).toFixed(0)}%`);
        },
        (error) => {
          logger.error('Failed to load', error);
          reject(error);
        }
      );
    });
  }

  playAnimation(name: string): void {
    const action = this.animations.get(name);
    if (!action) {
      logger.warn(`Animation not found: ${name}`);
      return;
    }

    if (this.currentAction) {
      this.currentAction.fadeOut(0.2);
    }

    action.reset();
    action.fadeIn(0.2);
    
    // Death animation should play once, others loop
    if (name === 'Death') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    
    action.play();
    this.currentAction = action;
  }

  setAnimationState(state: AnimationState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    
    // Map our states to RobotExpressive animation names
    const animMap: Record<AnimationState, string> = {
      'idle': 'Idle',
      'walk': 'Walking',
      'run': 'Running',
      'jump': 'Jump',
      'death': 'Death'
    };
    
    this.playAnimation(animMap[state]);
  }

  // Force animation switch without checking current state (for hysteresis)
  forceAnimationState(state: AnimationState): void {
    this.currentState = state;
    
    const animMap: Record<AnimationState, string> = {
      'idle': 'Idle',
      'walk': 'Walking',
      'run': 'Running',
      'jump': 'Jump',
      'death': 'Death'
    };
    
    this.playAnimation(animMap[state]);
  }

  update(dt: number): void {
    if (this.mixer) {
      this.mixer.update(dt);
    }
  }

  setPosition(x: number, y: number, z: number): void {
    if (this.model) {
      // Position represents feet, model origin is at feet (y=0)
      this.model.position.set(x, y, z);
    }
    // Collider gizmo is a child of the model, so it moves with it automatically
  }

  setRotation(yaw: number, pitch: number, roll: number = 0): void {
    if (this.model) {
      this.model.rotation.y = yaw;
      this.model.rotation.z = roll;
      // Don't apply pitch to body — it's an aiming angle, not body orientation.
      // Applying it shifts child objects (collider gizmo) away from the actual collision position.
    }
  }

  setVisible(visible: boolean): void {
    if (this.model) {
      this.model.visible = visible;
    }
  }

  setColliderVisible(visible: boolean): void {
    if (this.colliderGizmo) {
      this.colliderGizmo.visible = visible;
    }
  }

  removeColliderGizmo(): void {
    if (this.colliderGizmo && this.model) {
      this.colliderGizmo.visible = false;
      this.model.remove(this.colliderGizmo);
      console.log(`[PlayerModel] COLLIDER GIZMO REMOVED from model`);
    }
  }

  addColliderGizmo(): void {
    if (this.colliderGizmo && this.model && !this.model.children.includes(this.colliderGizmo)) {
      this.model.add(this.colliderGizmo);
      this.colliderGizmo.visible = true;
      console.log(`[PlayerModel] COLLIDER GIZMO RE-ADDED to model`);
    }
  }

  setScale(scale: number): void {
    if (this.model) {
      this.model.scale.setScalar(0.5 * scale); // Base scale is 0.5
    }
  }

  dispose(): void {
    console.log(`[PlayerModel] DISPOSE called`);
    if (this.model) {
      this.scene.remove(this.model);
      console.log(`[PlayerModel] MODEL REMOVED from scene`);
      this.mixer?.stopAllAction();
      this.animations.clear();
      this.model = null;
      this.mixer = null;
      this.currentAction = null;
    }
    if (this.colliderGizmo) {
      // Collider gizmo is a child of the model, so it's already removed when model is removed
      // Just dispose of resources
      this.colliderGizmo.geometry.dispose();
      (this.colliderGizmo.material as THREE.Material).dispose();
      this.colliderGizmo = null;
    }
  }
}
