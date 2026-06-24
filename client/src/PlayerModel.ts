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
          // Offset Y by -0.2 to align feet with collider bottom
          this.model.scale.setScalar(0.5);
          this.model.rotation.y = Math.PI; // Face forward
          this.model.position.y = -0.2; // Offset to align feet with ground
          
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

          // Create collider gizmo (wireframe capsule for hitbox visualization)
          // Hitbox: radius 0.8, total height 2.5 (0.9 cylinder + 0.8 hemisphere + 0.8 hemisphere)
          const colliderGeo = new THREE.CapsuleGeometry(0.8, 0.9, 4, 16);
          const colliderMat = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
            transparent: true,
            opacity: 0.3,
            depthTest: false // Always render on top
          });
          this.colliderGizmo = new THREE.Mesh(colliderGeo, colliderMat);
          this.colliderGizmo.position.y = 1.25; // Center at height 1.25 (half of 2.5)
          this.colliderGizmo.renderOrder = 999; // Render last (on top)
          this.scene.add(this.colliderGizmo);

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
      this.model.position.set(x, y, z);
    }
    if (this.colliderGizmo) {
      this.colliderGizmo.position.set(x, y + 1.25, z);
    }
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

  setScale(scale: number): void {
    if (this.model) {
      this.model.scale.setScalar(0.5 * scale); // Base scale is 0.5
    }
  }

  dispose(): void {
    if (this.model) {
      this.scene.remove(this.model);
      this.mixer?.stopAllAction();
      this.animations.clear();
      this.model = null;
      this.mixer = null;
      this.currentAction = null;
    }
    if (this.colliderGizmo) {
      this.scene.remove(this.colliderGizmo);
      this.colliderGizmo.geometry.dispose();
      (this.colliderGizmo.material as THREE.Material).dispose();
      this.colliderGizmo = null;
    }
  }
}
