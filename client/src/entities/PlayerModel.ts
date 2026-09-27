import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { PLAYER_RADIUS, CAPSULE_CYLINDER_HEIGHT, CAPSULE_CENTER_Y } from '../core/config.js';

import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('PlayerModel');

const X_AXIS = new THREE.Vector3(1, 0, 0);
const _pitchQuat = new THREE.Quaternion();

export type AnimationState = 'idle' | 'walk' | 'run' | 'jump' | 'death';

// Map our states to RobotExpressive animation names
const ANIM_NAMES: Record<AnimationState, string> = {
  'idle': 'Idle',
  'walk': 'Walking',
  'run': 'Running',
  'jump': 'Jump',
  'death': 'Death'
};

// Shared radial-gradient flash texture — one per process, all remote
// muzzle sprites reuse it
let _flashTex: THREE.CanvasTexture | null = null;
function makeFlashTexture(): THREE.CanvasTexture {
  if (_flashTex) return _flashTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,220,150,0.8)');
  g.addColorStop(1, 'rgba(255,180,80,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _flashTex = new THREE.CanvasTexture(c);
  return _flashTex;
}

export class PlayerModel {
  private scene: THREE.Scene;
  private model: THREE.Group | null = null;

  // Read-only access to the loaded object3D (debug tooling)
  get object3D(): THREE.Group | null { return this.model; }
  private mixer: THREE.AnimationMixer | null = null;
  private animations: Map<string, THREE.AnimationAction> = new Map();
  private currentAction: THREE.AnimationAction | null = null;
  private currentState: AnimationState = 'idle';
  private colliderGizmo: THREE.Mesh | null = null;
  // Aim-pitch bones: quaternion pitch stacked on top of the animated pose.
  // lastPitch is un-applied before the mixer runs so it never accumulates
  // (the mixer skips bones whose track value didn't change).
  private aimBones: { bone: THREE.Object3D; factor: number; last: THREE.Quaternion }[] = [];
  private aimPitch = 0;
  private handBone: THREE.Bone | null = null;
  private gun: THREE.Group | null = null;
  private gunBaseZ = 0;
  private gunKickZ = 0;
  private recoil = 0;
  private muzzleFlash: THREE.Sprite | null = null;
  private flashTTL = 0;

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
              // SkinnedMesh bind-pose bounds don't track bone-driven verts —
              // wrong bounds get it frustum-culled when it shouldn't be
              if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
                child.frustumCulled = false;
              }
            }
            // Grab aim/attachment bones — name-based since the model also has
            // same-named plain nodes; only real Bones qualify
            if ((child as THREE.Bone).isBone) {
              if (child.name === 'Head') {
                this.aimBones.push({ bone: child, factor: 0.4, last: new THREE.Quaternion() });
              } else if (child.name === 'Abdomen') {
                this.aimBones.push({ bone: child, factor: 0.6, last: new THREE.Quaternion() });
              // GLTFLoader sanitizes names ('Palm2.R' -> 'Palm2R')
              } else if (child.name === 'Palm2R' && !this.handBone) {
                this.handBone = child as THREE.Bone;
              }
            }
          });
          logger.debug(`Aim bones: ${this.aimBones.map(b => b.bone.name).join(', ') || 'NONE'} | hand: ${this.handBone?.name ?? 'NONE'}`);

          // Scale and rotate to match our coordinate system
          // Model bounding box at scale 1.0: x: 3.2, y: 4.8, z: 3.2
          // At scale 0.5: x: 1.6, y: 2.4, z: 1.6
          // Hitbox: radius 0.8 (width 1.6), height 2.0
          // Scale factor 0.5 matches width, but model is taller (2.4 vs 2.0)
          // RobotExpressive.glb origin is at feet (y=0), not center
          this.model.scale.setScalar(0.5);
          this.model.rotation.y = Math.PI; // Face forward

          // Procedural gun in the right hand — follows every animation.
          if (this.handBone) {
            const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.55, metalness: 0.6, emissive: 0x334455, emissiveIntensity: 0.8 });
            this.gun = new THREE.Group();
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.9), gunMat);
            body.position.z = 0.25;
            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55), gunMat);
            barrel.rotation.x = Math.PI / 2;
            barrel.position.set(0, 0.05, 0.75);
            this.gun.add(body, barrel);
            // Measure bone world scale AFTER model.scale so the gun lands
            // real-world size (bones carry the armature's ~100x scale)
            this.model.updateMatrixWorld(true);
            const ws = this.handBone.getWorldScale(new THREE.Vector3());
            logger.debug(`GUN ATTACH`, { hand: this.handBone.name, worldScale: ws.x, aimBones: this.aimBones.length });
            this.gun.scale.setScalar(0.7 / ws.x); // ~0.7m gun in world space
            this.gunBaseZ = 0.05 / ws.x;
            this.gunKickZ = 0.15 / ws.x; // recoil distance in bone units
            this.gun.position.set(0, 0.05 / ws.x, this.gunBaseZ);
            this.gun.rotation.y = Math.PI; // barrel points forward

            // Muzzle flash: additive sprite at the barrel tip, flashed on
            // fire() and faded in update(). Cheap (one sprite per remote),
            // blooms nicely at distance — this is what makes remote fire
            // readable when tracking small targets in the sky.
            const flashMat = new THREE.SpriteMaterial({
              map: makeFlashTexture(),
              color: 0xaad4ff,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
              transparent: true,
            });
            this.muzzleFlash = new THREE.Sprite(flashMat);
            this.muzzleFlash.scale.setScalar(0); // hidden until fire()
            this.muzzleFlash.position.set(0, 0.05, 1.0); // barrel tip (gun-local)
            this.gun.add(this.muzzleFlash);

            this.handBone.add(this.gun);
          } else {
            logger.warn('GUN NOT ATTACHED — no hand bone found');
          }
          
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
          logger.debug('MODEL ADDED to scene', { children: this.scene.children.length });

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
          logger.debug('COLLIDER GIZMO ADDED to model', { children: this.scene.children.length });

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

    // (no per-clip head bookkeeping — the pitch un-apply in update() handles
    // both tracked and untracked head bones, including the case where the
    // mixer skips writing because the track value didn't change)

    if (this.currentAction) {
      this.currentAction.fadeOut(0.2);
    }

    action.reset();
    action.fadeIn(0.2);
    action.timeScale = 1;
    // Death: play once, clamp the corpse.
    // Jump: Tribes-style fall cycle — ping-pong at ~1/3 speed. LoopRepeat
    // restarts the clip every cycle (bunny-hop midair); a frozen clamp
    // reads as a statue. The slow reversed tuck↔extend cycle reads as
    // flailing/swimming through air and needs no separate fall anim.
    if (name === 'Death') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else if (name === 'Jump') {
      action.setLoop(THREE.LoopPingPong, Infinity);
      action.timeScale = 0.35;
      action.clampWhenFinished = false;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    }
    
    action.play();
    this.currentAction = action;
  }

  get animationState(): AnimationState {
    return this.currentState;
  }

  setAnimationState(state: AnimationState): void {
    if (this.currentState === state) return;
    this.forceAnimationState(state);
  }

  // Force animation switch without checking current state (for hysteresis)
  forceAnimationState(state: AnimationState): void {
    this.currentState = state;
    this.playAnimation(ANIM_NAMES[state]);
  }

  update(dt: number): void {
    // Remove last frame's pitch BEFORE the mixer writes. The mixer skips
    // bones whose track value didn't change, so without this the multiply
    // would accumulate on a stale pitched value and the bone spins.
    for (const ab of this.aimBones) {
      ab.bone.quaternion.multiply(_pitchQuat.copy(ab.last).invert());
    }
    if (this.mixer) {
      this.mixer.update(dt);
    }
    for (const ab of this.aimBones) {
      // Negative X tilts up for positive pitch (looking up)
      ab.last.setFromAxisAngle(X_AXIS, -this.aimPitch * ab.factor);
      ab.bone.quaternion.multiply(ab.last);
    }
    // Recoil: exponential decay kick on the gun (position + muzzle flip)
    if (this.gun && this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - dt * 7);
      const k = this.recoil * this.recoil; // snappy attack, soft release
      this.gun.position.z = this.gunBaseZ - k * this.gunKickZ;
      this.gun.rotation.x = -k * 0.45;
    }
    // Muzzle flash: ~90ms pop, decays with the recoil curve
    if (this.muzzleFlash && this.flashTTL > 0) {
      this.flashTTL = Math.max(0, this.flashTTL - dt);
      const f = this.flashTTL / 0.09;
      this.muzzleFlash.scale.setScalar(0.5 * f + 0.15 * f * f);
      (this.muzzleFlash.material as THREE.SpriteMaterial).opacity = f;
    } else if (this.muzzleFlash && this.muzzleFlash.scale.x > 0) {
      this.muzzleFlash.scale.setScalar(0);
    }
  }

  // Procedural fire kick + muzzle flash — call when the remote player shoots
  fire(): void {
    this.recoil = 1;
    this.flashTTL = 0.09;
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
      this.aimPitch = pitch;
      // Don't apply pitch to body — it's an aiming angle, not body orientation.
      // It goes to the head bone in update(), after the mixer writes the pose.
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
      logger.debug('COLLIDER GIZMO REMOVED from model');
    }
  }

  addColliderGizmo(): void {
    if (this.colliderGizmo && this.model && !this.model.children.includes(this.colliderGizmo)) {
      this.model.add(this.colliderGizmo);
      this.colliderGizmo.visible = true;
      logger.debug('COLLIDER GIZMO RE-ADDED to model');
    }
  }

  setScale(scale: number): void {
    if (this.model) {
      this.model.scale.setScalar(0.5 * scale); // Base scale is 0.5
    }
  }

  dispose(): void {
    logger.debug('DISPOSE called');
    if (this.model) {
      this.scene.remove(this.model);
      logger.debug('MODEL REMOVED from scene');
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
