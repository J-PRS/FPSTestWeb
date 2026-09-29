import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { PLAYER_RADIUS, CAPSULE_CYLINDER_HEIGHT, CAPSULE_CENTER_Y } from '../core/config.js';
import { getProjectileConfig } from '../projectiles/index.js';
import { urlParams } from '../core/params.js';

import { ChildLogger } from '../core/Logger.js';
import { buildGibParts, bakeDeathParts, type GibPart } from './playerGibs.js';

const logger = new ChildLogger('PlayerModel');

const X_AXIS = new THREE.Vector3(1, 0, 0);
const _pitchQuat = new THREE.Quaternion();
const _white = new THREE.Color(0xffffff);
const _footW = new THREE.Vector3();
const _footQ = new THREE.Quaternion();
const _footPQ = new THREE.Quaternion();
const _leanEul = new THREE.Euler();
const _leanNo = new THREE.Quaternion();
const _leanYes = new THREE.Quaternion();
const _leanOff = new THREE.Vector3();
const _leanA = new THREE.Vector3();
const _leanB = new THREE.Vector3();
// Jet-lean pivot: the pack thrusts from the sternum, so the body tilts
// about that point and the legs swing — feet-pivot lean reads as a
// cardboard cutout tipping over.
const LEAN_PIVOT_Y = 1.3;

export type { AnimationState } from './playerClips.js';
import { ANIM_NAMES, KNIGHT_ANIMS, ONESHOT_CLIPS,
  normBone, makeFlashTexture, type AnimationState } from './playerClips.js';
import { bakeUALClips } from './playerUal.js';

export class PlayerModel {
  private scene: THREE.Scene;
  private model: THREE.Group | null = null;
  private modelScale = 0.5;
  // Disposed before the GLB finishes loading (pruned remote, ?dummy reaped
  // by the roster cleanup): the async onLoad must not re-add the mesh or
  // repopulate animations — that zombie re-add was the invisible-model bug.
  private _disposed = false;
  // Warn-once per clip name — a bad clip set used to flood the log at
  // frame rate (11730 'Animation not found' lines in one session).
  private _warnedAnims = new Set<string>();

  // Read-only access to the loaded object3D (debug tooling)
  get object3D(): THREE.Group | null { return this.model; }
  private mixer: THREE.AnimationMixer | null = null;
  private animations: Map<string, THREE.AnimationAction> = new Map();
  private _loaded = false;
  // Requests that arrive before the GLB lands — anim state still applies
  // on load instead of warning against an empty map.
  private _queuedAnim: string | null = null;
  private currentAction: THREE.AnimationAction | null = null;
  private currentState: AnimationState = 'idle';
  private colliderGizmo: THREE.Mesh | null = null;
  // Aim-pitch bones: quaternion pitch stacked on top of the animated pose.
  // lastPitch is un-applied before the mixer runs so it never accumulates
  // (the mixer skips bones whose track value didn't change).
  private aimBones: { bone: THREE.Object3D; factor: number; last: THREE.Quaternion }[] = [];
  private aimPitch = 0;
  // Whole-body jet lean: targets set by the owner (RemotePlayer,
  // PlayerVisuals) from velocity-in-facing-frame; damped toward them in
  // update() so the tilt eases in/out instead of snapping per frame.
  private leanP = 0; private leanR = 0;
  private leanPT = 0; private leanRT = 0;
  private lastRoll = 0;
  private handBone: THREE.Bone | null = null;
  private gun: THREE.Group | null = null;
  private gunBaseZ = 0;
  private gunKickZ = 0;
  private recoil = 0;
  private muzzleFlash: THREE.Sprite | null = null;
  private flashTTL = 0;
  // Damage flash — same white-pop the creatures do (flash timer × brighter
  // surface). Skinned materials can't use instanceColor, so we lerp each
  // material's emissive toward white and back from a cached baseline.
  private dmgFlash = 0;
  private flashMats: { m: THREE.MeshStandardMaterial; e: THREE.Color; i: number }[] = [];

  // ---- Retargeted UAL clips ------------------------------------------
  // Fetch/parse/bake caches live in playerUal.ts; this class only wires
  // the baked clip table into its own mixer once it resolves.
  private currentClipName: string | null = null;
  private playingUAL = false;
  // Foot bones are IK targets detached from the leg chain — retargeted
  // clips leave them frozen mid-air. When a UAL clip plays, snap each foot
  // to its shin tip (the *_end leaf node follows the skinned leg).
  private footSnaps: { foot: THREE.Object3D; shin: THREE.Object3D; tip: THREE.Object3D }[] = [];

  // ---- Gibs: real body parts for the death shatter ---------------------
  // Grouped at load, baked posed on death — logic lives in playerGibs.ts.
  private gibParts: GibPart[] | null = null;

  /** Posed body-part fragments at the corpse's current stance — recentered
   *  chunk geometries + their world centroids. Null until loaded / if the
   *  model has no skinned meshes (caller falls back to generic debris). */
  deathParts(): { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] | null {
    if (!this.gibParts && this.model) this.gibParts = buildGibParts(this.model);
    if (!this.gibParts || !this.model) return null;
    return bakeDeathParts(this.model, this.gibParts);
  }

  /** 'robot' = RobotExpressive + retargeted UAL clips (backburner path).
   *  'mannequin' = the UAL's own rig — clips play natively, no retarget.
   *  'knight' = Quaternius Knight_Male — the heavy-class silhouette;
   *  native clips, armored read at distance. */
  readonly variant: 'robot' | 'mannequin' | 'knight';

  constructor(scene: THREE.Scene, variant?: 'robot' | 'mannequin' | 'knight') {
    this.scene = scene;
    this.variant = variant ?? (urlParams.get('model') === 'mannequin' ? 'mannequin' : 'robot');
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const mann = this.variant === 'mannequin';
    const knight = this.variant === 'knight';

    return new Promise((resolve, reject) => {
      loader.load(
        knight ? '/assets/models/knight.glb'
          : mann ? '/assets/models/mannequin.glb'
          : '/assets/models/RobotExpressive.glb',
        (gltf) => {
          if (this._disposed) { resolve(); return; }
          this.model = gltf.scene;
          
          // Log model bounding box for hitbox calibration
          const box = new THREE.Box3().setFromObject(this.model);
          const size = box.getSize(new THREE.Vector3());
          const min = box.min;
          const max = box.max;
          logger.debug(`Model bounding box: size=(${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)}) min=(${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}) max=(${max.x.toFixed(2)},${max.y.toFixed(2)},${max.z.toFixed(2)})`);
          
          // Enable shadow casting + grab aim/attachment bones
          this.model.traverse((child) => this.prepareChild(child));
          logger.debug(`Aim bones: ${this.aimBones.map(b => b.bone.name).join(', ') || 'NONE'} | hand: ${this.handBone?.name ?? 'NONE'}`);

          // Scale and rotate to match our coordinate system
          // Model bounding box at scale 1.0: x: 3.2, y: 4.8, z: 3.2
          // At scale 0.5: x: 1.6, y: 2.4, z: 1.6
          // Hitbox: radius 0.8 (width 1.6), height 2.0
          // Scale factor 0.5 matches width, but model is taller (2.4 vs 2.0)
          // RobotExpressive.glb origin is at feet (y=0), not center
          this.model.scale.setScalar(mann || knight ? 2.0 / size.y : 0.5); // mannequin+knight: fit the 2m capsule — robot stays at its calibrated 0.5
          this.model.rotation.y = Math.PI; // Face forward
          this.modelScale = mann || knight ? 2.0 / size.y : 0.5;

          // Procedural gun in the right hand — follows every animation.
          if (this.handBone) this.attachGun(mann);
          else logger.warn('GUN NOT ATTACHED — no hand bone found');
          
          // No Y offset needed — model origin is already at feet
          
          // Set up animation mixer
          this.mixer = new THREE.AnimationMixer(this.model);
          
          // Store animations with mapping. Mannequin clips ARE the UAL
          // clips natively — alias them under the UAL_ names the state map
          // prefers so ANIM_NAMES resolves without a retarget pass.
          for (const clip of gltf.animations) this.registerClip(clip, mann, knight);
          
          logger.debug('Loaded animations:', Array.from(this.animations.keys()));
          
          this._loaded = true;
          // Start with whatever the last request was (remotes spawn mid-
          // load and ask for Running/Walking before the mixer exists).
          this.playAnimation(this._queuedAnim ?? (mann ? 'UAL_Idle_Loop' : 'Idle'));
          this._queuedAnim = null;

          // Retargeted UAL clips arrive async — a native clip plays until
          // they land, then the current state re-resolves onto the better
          // clip. Cached globally so only the first model pays the bake.
          // The mannequin binds UAL clips natively and the knight ships
          // its own set — neither pays a retarget pass.
          // Robot-only: its UAL2 retarget reads clean. The mannequin tried
          // the same bake — UE bone-axis conventions (X-along-bone vs the
          // Rigify Y-along) bake a face-down slide; its Crouch_Fwd tuck
          // reads better, so it skips the pass. Knight is native-only.
          if (!mann && !knight) this.retargetUAL();
          
          this.scene.add(this.model);
          logger.debug('MODEL ADDED to scene', { children: this.scene.children.length });

          // Create collider gizmo (wireframe capsule for hitbox visualization)
          // Uses same constants as collision detection — single source of truth in config.ts
          // CapsuleGeometry(radius, cylinderHeight, ...) — cylinderHeight excludes hemispheres
          // Model is scaled by 0.5, so divide by scale to get correct world size
          const colliderGeo = new THREE.CapsuleGeometry(PLAYER_RADIUS / this.modelScale, CAPSULE_CYLINDER_HEIGHT / this.modelScale, 4, 16);
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
          this.colliderGizmo.position.y = CAPSULE_CENTER_Y / this.modelScale;
          this.colliderGizmo.renderOrder = 999; // Render last (on top)
          // Hitbox visualization is a debug overlay — same flag as the
          // AOE blast wireframes (menu DEBUG toggle / ?debug).
          this.colliderGizmo.visible = urlParams.debug;
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

  // Per-node load prep: mesh shadows/frustum fix + flash material capture,
  // then rig-bone capture (aim chain, hand grip, foot-snap helpers).
  private prepareChild(child: THREE.Object3D): void {
    if (child instanceof THREE.Mesh) this.prepareMesh(child);
    if ((child as THREE.Bone).isBone) this.captureBone(child);
  }

  private prepareMesh(child: THREE.Mesh): void {
      child.castShadow = true;
      child.receiveShadow = true;
      // SkinnedMesh bind-pose bounds don't track bone-driven verts —
      // wrong bounds get it frustum-culled when it shouldn't be
      if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
        child.frustumCulled = false;
      }
      // Capture emissive materials for the damage flash — dedupe,
      // a GLB often shares one material across several meshes.
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) {
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial
          && !this.flashMats.some(f => f.m === m)) {
          const sm = m as THREE.MeshStandardMaterial;
          this.flashMats.push({ m: sm, e: sm.emissive.clone(), i: sm.emissiveIntensity });
        }
      }
    }

  // Name-based since the model also has same-named plain nodes; only real
  // Bones qualify. Mannequin bones are DEF-* (normBone-stripped compare).
  private captureBone(child: THREE.Object3D): void {
    const nb = normBone(child.name);
    if (child.name === 'Head' || nb === 'defhead' || nb === 'head') {
      this.aimBones.push({ bone: child, factor: 0.4, last: new THREE.Quaternion() });
    } else if (child.name === 'Abdomen' || nb === 'defspine001' || nb === 'spine') {
      this.aimBones.push({ bone: child, factor: 0.6, last: new THREE.Quaternion() });
    // GLTFLoader sanitizes names ('Palm2.R' -> 'Palm2R'); the
    // Quaternius rigs put the grip in FistR.
    } else if ((child.name === 'Palm2R' || nb === 'defhandr' || nb === 'fistr') && !this.handBone) {
      this.handBone = child as THREE.Bone;
    }
    // Foot-snap rig for retargeted clips on the robot rig (UAL
    // doesn't drive its IK foot bones). The mannequin's feet are
    // real in-chain bones — nothing to snap.
    if (child.name === 'FootL' || child.name === 'FootR') this.captureFootBone(child);
  }

  private captureFootBone(child: THREE.Object3D): void {
    const side = child.name === 'FootL' ? 'L' : 'R';
    const shin = this.model!.getObjectByName(`LowerLeg${side}`);
    const tip = this.model!.getObjectByName(`LowerLeg${side}_end`);
    if (shin && tip) this.footSnaps.push({ foot: child, shin, tip });
  }

  // Procedural gun in the right hand — follows every animation.
  private attachGun(mann: boolean): void {
    const handBone = this.handBone!;
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
    this.model!.updateMatrixWorld(true);
    const ws = handBone.getWorldScale(new THREE.Vector3());
    logger.debug(`GUN ATTACH`, { hand: handBone.name, worldScale: ws.x, aimBones: this.aimBones.length });
    this.gun.scale.setScalar(0.7 / ws.x); // ~0.7m gun in world space
    this.gunBaseZ = 0.05 / ws.x;
    this.gunKickZ = 0.15 / ws.x; // recoil distance in bone units
    this.gun.position.set(0, 0.05 / ws.x, this.gunBaseZ);
    // Robot palm bones: barrel forward = local -Z flipped by π yaw.
    // UAL hand bones: barrel runs along the arm axis — +Y bone yaw
    // (verified in the gun-probe rotation sweep).
    if (mann) this.gun.rotation.y = Math.PI / 2; // verified via gun-probe gallery: barrel runs along the arm's aim axis
    else this.gun.rotation.y = Math.PI;

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

    handBone.add(this.gun);
  }

  // Mannequin/knight clips need their hip XZ root motion stripped — the
  // entity owns world position, and loop clips otherwise translate the
  // mesh out from under the hitbox each cycle. Y stays (the crouch dip).
  private registerClip(clip: THREE.AnimationClip, mann: boolean, knight: boolean): void {
    if (mann || knight) {
      for (const tr of clip.tracks) {
        if (!tr.name.endsWith('.position')) continue;
        const node = tr.name.slice(0, tr.name.indexOf('.'));
        if (normBone(node) !== 'defhips' && normBone(node) !== 'root' && normBone(node) !== 'hips' && normBone(node) !== 'bone') continue;
        const v = tr.values;
        for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
      }
    }
    const action = this.mixer!.clipAction(clip);
    this.animations.set(clip.name, action);
    if (mann) this.animations.set('UAL_' + clip.name, action);
  }

  playAnimation(name: string): void {
    if (!this._loaded) { this._queuedAnim = name; return; }
    const action = this.animations.get(name);
    if (!action) {
      if (!this._warnedAnims.has(name)) {
        this._warnedAnims.add(name);
        logger.warn(`Animation not found: ${name}`);
      }
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
    if (name === 'Death' || name === 'UAL_Death01') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else if (ONESHOT_CLIPS.has(name)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = false;
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
    this.currentClipName = name;
    this.playingUAL = name.startsWith('UAL_');
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
    if (this.variant === 'knight') {
      this.playAnimation(KNIGHT_ANIMS[state]);
      return;
    }
    // Mannequin has no native slide clip — ski rides the tucked Crouch_Fwd
    // (the UAL2 retarget exists but bakes limb-axis artifacts on this rig).
    const [ual, fallback] = ANIM_NAMES[state];
    if (this.variant === 'mannequin' && state === 'ski') {
      this.playAnimation(this.animations.has('UAL_Crouch_Fwd_Loop') ? 'UAL_Crouch_Fwd_Loop' : 'Crouch_Fwd_Loop');
      return;
    }
    // Prefer the retargeted clip; fall back to the native emote until the
    // UAL bake lands (or forever if the retarget failed).
    this.playAnimation(this.animations.has(ual) ? ual : fallback);
  }

  /**
   * Bake the Quaternius UAL clips onto the robot skeleton — once per
   * process. The first loaded model pays the resample; every later
   * instance reuses the name-keyed clip data (all robots share the same
   * rest pose, so the results are identical).
   */
  private retargetUAL(): void {
    if (!this.model) return;
    bakeUALClips(this.model, this.variant).then(baked => {
      if (this._disposed || !this.mixer || !this.model) return;
      for (const [name, clip] of baked) {
        this.animations.set(name, this.mixer.clipAction(clip));
      }
      // Re-resolve the current state onto the better clip if one landed.
      const want = this.variant === 'knight' ? KNIGHT_ANIMS[this.currentState] : ANIM_NAMES[this.currentState][0];
      this.playAnimation(this.animations.has(want) ? want : (this.currentClipName ?? 'Idle'));
    }).catch((e) => { logger.warn('UAL bake failed for ' + this.variant, e); });
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
    this.snapFeetToShins();
    this.tickGunFx(dt);
    this.tickJetLean(dt);
    this.tickDamageFlash(dt);
  }

  // Retargeted clips don't drive the robot's IK foot bones — pin each
  // foot to its shin tip and give it the shin's orientation.
  private snapFeetToShins(): void {
    if (!this.playingUAL || !this.footSnaps.length) return;
    for (const fs of this.footSnaps) {
      fs.tip.getWorldPosition(_footW); // forces fresh chain matrices
      const parent = fs.foot.parent!;
      fs.foot.position.copy(parent.worldToLocal(_footW));
      fs.shin.getWorldQuaternion(_footQ);
      parent.getWorldQuaternion(_footPQ).invert();
      fs.foot.quaternion.copy(_footPQ.multiply(_footQ));
    }
  }

  // Recoil: exponential decay kick on the gun (position + muzzle flip);
  // muzzle flash is a ~90ms pop decaying on the same curve.
  private tickGunFx(dt: number): void {
    if (this.gun && this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - dt * 7);
      const k = this.recoil * this.recoil; // snappy attack, soft release
      this.gun.position.z = this.gunBaseZ - k * this.gunKickZ;
      this.gun.rotation.x = -k * 0.45;
    }
    if (this.muzzleFlash && this.flashTTL > 0) {
      this.flashTTL = Math.max(0, this.flashTTL - dt);
      const f = this.flashTTL / 0.09;
      this.muzzleFlash.scale.setScalar(0.5 * f + 0.15 * f * f);
      (this.muzzleFlash.material as THREE.SpriteMaterial).opacity = f;
    } else if (this.muzzleFlash && this.muzzleFlash.scale.x > 0) {
      this.muzzleFlash.scale.setScalar(0);
    }
  }

  // Jet lean: ease toward the target, then write the composed tilt
  // on top of yaw/roll. setRotation may run before or after update,
  // so rotation.z is rebuilt here from lastRoll + lean — never read
  // the euler back, or the lean would double-apply.
  private tickJetLean(dt: number): void {
    if (!this.model || (this.leanPT === 0 && this.leanRT === 0 && this.leanP === 0 && this.leanR === 0)) return;
    const k = 1 - Math.exp(-dt * 7);
    this.leanP += (this.leanPT - this.leanP) * k;
    this.leanR += (this.leanRT - this.leanR) * k;
    if (Math.abs(this.leanP) < 1e-3 && this.leanPT === 0) this.leanP = 0;
    if (Math.abs(this.leanR) < 1e-3 && this.leanRT === 0) this.leanR = 0;
    this.model.rotation.x = this.leanP;
    this.model.rotation.z = this.lastRoll + this.leanR;
    // Pivot compensation: keep the sternum where the un-leaned pose
    // would put it, so the tilt swings the legs instead of the chest.
    const yaw = this.model.rotation.y;
    _leanNo.setFromEuler(_leanEul.set(0, yaw, this.lastRoll, 'YXZ'));
    _leanYes.setFromEuler(_leanEul.set(this.leanP, yaw, this.lastRoll + this.leanR, 'YXZ'));
    _leanOff.set(0, LEAN_PIVOT_Y, 0);
    _leanA.copy(_leanOff).applyQuaternion(_leanNo);
    _leanB.copy(_leanOff).applyQuaternion(_leanYes);
    this.model.position.add(_leanA.sub(_leanB));
  }

  // Damage flash: emissive snaps toward white then decays back to each
  // material's own baseline (the gun keeps its 0x334455 glow).
  private tickDamageFlash(dt: number): void {
    if (this.dmgFlash <= 0) return;
    this.dmgFlash = Math.max(0, this.dmgFlash - dt);
    const k = this.dmgFlash / 0.15;
    for (const f of this.flashMats) {
      f.m.emissive.copy(f.e).lerp(_white, k);
      f.m.emissiveIntensity = f.i + k * 2.5;
    }
  }

  /** Damage white-pop — creature-style hit readability on the robot body. */
  damageFlash(): void {
    this.dmgFlash = 0.15;
  }

  // Procedural fire kick + muzzle flash — call when the remote player shoots.
  // weaponType tints the flash so an LG blast reads differently to a shotgun.
  fire(weaponType?: number): void {
    this.recoil = 1;
    this.flashTTL = 0.09;
    // Reset to the default tint too — a shotgun shouldn't leave the next
    // LG shot flashing amber.
    if (this.muzzleFlash) {
      const glow = weaponType !== undefined ? getProjectileConfig(weaponType)?.glowColor : undefined;
      (this.muzzleFlash.material as THREE.SpriteMaterial).color.set(glow ?? 0xaad4ff);
    }
  }

  setPosition(x: number, y: number, z: number): void {
    if (this.model) {
      // Position represents feet, model origin is at feet (y=0)
      this.model.position.set(x, y, z);
    }
    // Collider gizmo is a child of the model, so it moves with it automatically
  }

  /** Where the rendered body actually is (feet) — null before the GLB
   *  loads. The bot watchdog diffs this against the logical position to
   *  catch a stalled tick/interpolation path. */
  getModelPosition(out: THREE.Vector3): boolean {
    if (!this.model) return false;
    out.copy(this.model.position);
    return true;
  }

  /** Directional body lean (jet thrust tilt): pitch = forward/back,
   *  roll = sideways. Set every frame a jet is active; pass 0,0 to ease
   *  back to level. Applied to the whole model so it composes with
   *  whatever clip is playing — TA-style directional jetting reads from
   *  body tilt, not a per-direction clip set (UAL has none). */
  setBodyLean(pitch: number, roll: number): void {
    this.leanPT = pitch;
    this.leanRT = roll;
  }

  setRotation(yaw: number, pitch: number, roll: number = 0): void {
    if (this.model) {
      // YXZ so lean pitch/roll resolve in the yawed (facing) frame.
      if (this.model.rotation.order !== 'YXZ') this.model.rotation.order = 'YXZ';
      this.model.rotation.y = yaw;
      this.lastRoll = roll;
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
      this.colliderGizmo.visible = visible && urlParams.debug;
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
      this.colliderGizmo.visible = urlParams.debug;
      logger.debug('COLLIDER GIZMO RE-ADDED to model');
    }
  }

  setScale(scale: number): void {
    if (this.model) {
      // Multiply the model's own fit scale (0.5 robot, 2.0/size.y mannequin)
      // so the armor-class bump composes with whichever GLB loaded.
      this.model.scale.setScalar((this.modelScale || 0.5) * scale);
    }
  }

  dispose(): void {
    logger.debug('DISPOSE called');
    this._disposed = true;
    if (this.model) {
      this.scene.remove(this.model);
      logger.debug('MODEL REMOVED from scene');
      this.mixer?.stopAllAction();
      this.animations.clear();
      this.model = null;
      this.mixer = null;
      this.currentAction = null;
      this.gibParts = null; // just (mesh, indices) — nothing GPU-owned here
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
