import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ChildLogger } from './Logger.js';

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
          logger.debug('Model bounding box:', size);
          
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
          // Model origin is at center, so we need to offset position by half height
          this.model.scale.setScalar(0.5);
          this.model.rotation.y = Math.PI; // Face forward
          // Offset model so its feet are at the position (model origin is at center)
          // Model height at scale 0.5 is 2.4, so half is 1.2
          this.model.position.y = 1.2;
          
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
          // Match actual collision volume from config.ts: PLAYER_RADIUS=0.8, PLAYER_HEIGHT=2.0
          // CapsuleGeometry(radius, height, radialSegments, heightSegments)
          // Height parameter is the cylinder height only (not including hemispheres)
          // Total height = cylinder height + 2 * radius
          // For total height 2.0 with radius 0.8: cylinder height = 2.0 - 2*0.8 = 0.4
          // Model is scaled by 0.5, so we need to divide geometry by scale to get correct world size
          const colliderGeo = new THREE.CapsuleGeometry(0.8 / 0.5, 0.4 / 0.5, 4, 16);
          const colliderMat = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
            transparent: true,
            opacity: 0.3,
            depthTest: false // Always render on top
          });
          this.colliderGizmo = new THREE.Mesh(colliderGeo, colliderMat);
          // Model is at feet + 1.2, but collider center should be at feet + 1.0 (half player height)
          // So collider should be at y = -0.2 in world space relative to model center
          // Since model is scaled by 0.5, local position is multiplied by scale
          // To get -0.2 world offset: local = -0.2 / 0.5 = -0.4
          this.colliderGizmo.position.y = -0.4;
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
      // Position represents feet, model origin is at center
      // Model height at scale 0.5 is 2.4, so offset by half (1.2)
      this.model.position.set(x, y + 1.2, z);
    }
    // Collider gizmo is now a child of the model, so it moves with it automatically
  }

  setRotation(yaw: number, pitch: number, roll: number = 0): void {
    if (this.model) {
      this.model.rotation.y = yaw;
      this.model.rotation.x = pitch;
      this.model.rotation.z = roll;
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
      this.model.remove(this.colliderGizmo);
      console.log(`[PlayerModel] COLLIDER GIZMO REMOVED from model`);
    }
  }

  addColliderGizmo(): void {
    if (this.colliderGizmo && this.model && !this.model.children.includes(this.colliderGizmo)) {
      this.model.add(this.colliderGizmo);
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
