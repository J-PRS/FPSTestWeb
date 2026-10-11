import * as THREE from 'three';
import { mkGltfLoader, loadGltfCached } from '../gltfLoad';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

import { PLAYER_RADIUS, CAPSULE_CYLINDER_HEIGHT, CAPSULE_CENTER_Y } from '../core/config.js';
import { urlParams } from '../core/params.js';

import { ChildLogger } from '../core/Logger.js';
import { glitch } from '../core/fxDiag.js';
import { buildGibParts, bakeDeathParts, type GibPart } from './playerGibs.js';

const logger = new ChildLogger('PlayerModel');

// Locomotion clip surgery (stripHipXZ/dampenSway/DIR8) lives in
// playerClipSurgery.ts — extracted so the layered-anim carve-up is
// testable without loading the rig.

export type { AnimationState } from './playerClips.js';
import { CLASS_BODY_SPEC, RIG_MANIFEST,
  normBone, type AnimationState } from './playerClips.js';
import { computeRootMotionNodes } from './playerClipSurgery.js';
import { ModelFx } from './modelFx.js';
import { PlayerAnim } from './playerAnim.js';
import { PlayerCollider } from './playerCollider.js';
import { PlayerGun } from './playerGun.js';
import { PlayerDistal } from './playerDistal.js';
import { PlayerModelLod, smoothShade } from './playerModelLod.js';
import { PlayerMats } from './playerMats.js';
import { PoseControl } from './playerPose.js';
import { WeaponType } from '../../../shared/weapons.js';

export type PlayerModelVariant = 'robot' | 'mannequin' | 'knight' | 'scifisoldier' | 'cybersoldier' | 'vexa' | 'polyart';

export class PlayerModel {
  private scene: THREE.Scene;
  model: THREE.Group | null = null; // public — ModelFx writes lean/pivot
  private modelScale = 0.5;
  // Vertical lift for rigs whose authored origin isn't at their feet —
  // keeps the mesh's lowest point on the logical entity position.
  private feetOffsetY = 0;
  // Disposed before the GLB finishes loading (pruned remote, ?dummy reaped
  // by the roster cleanup): the async onLoad must not re-add the mesh or
  // repopulate animations — that zombie re-add was the invisible-model bug.
  private _disposed = false;

  // Read-only access to the loaded object3D (debug tooling)
  get object3D(): THREE.Group | null { return this.model; }
  /** Anim host surface — reads live so the rig fallback's pose/variant
   *  re-assignment in load() stays visible to the controller. */
  get disposed(): boolean { return this._disposed; }
  // Mixer, clip table, fades, and the anim state machine live in
  // playerAnim.ts — this is the host it reads back through.
  readonly anim = new PlayerAnim(this);
  /** PlayerVisuals reads the raw state by bracket for its own cascade. */
  get currentState(): AnimationState { return this.anim.currentState; }
  /** True while a dedicated directional clip drives the current action. */
  get dirClipActive(): boolean { return this.anim.dirClipActive; }
  /** Clip table (posedump reaches it by bracket cast). */
  get animations(): Map<string, THREE.AnimationAction> { return this.anim.animations; }
  // Debug hitbox wireframe (geometry, hex, debug/force visibility,
  // class-capsule restash) lives in playerCollider.ts.
  private readonly collider = new PlayerCollider();
  // Post-mixer pose corrections (aim pitch, hip-fire hold, spine lock,
  // IK foot snap) live in playerPose.ts — PoseControl owns the bone
  // lists it writes into.
  pose: PoseControl; // public — PlayerAnim drives it as host state

  /** Live-tune the hand-bone mount rotation (posedump loop) — deg euler. */
  debugSetGunRot(x: number, y: number, z: number): void {
    this.gunCtl.setRotDeg(x, y, z);
  }

  /** Live-tune the hold pose (posedump iteration loop) — deg per role. */
  debugSetHold(upper: [number, number, number], lower: [number, number, number], hand: [number, number, number], lUpper: [number, number, number] = upper.map(v => -v) as [number, number, number], lLower: [number, number, number] = lower, lHand: [number, number, number] = hand): void {
    this.pose.debugSetHold(upper, lower, hand, lUpper, lLower, lHand);
  }
  // Weapon-swap dip — mirrors the first-person viewmodel's lower→raise:
  // the held gun drops toward the hip and the muzzle tips down, then the
  // "new" weapon comes back up. Purely cosmetic on the body model (the
  // prop gun doesn't change), but the motion is the readable swap tell.
  // Prop-gun transform + lean roll live on the gun controller
  // (playerGun.ts) — the FX pass reads them through these delegates,
  // which keep the ModelFxHost surface stable.
  private readonly gunCtl = new PlayerGun();
  get gun(): THREE.Group | null { return this.gunCtl.group; }
  get muzzleFlash(): THREE.Sprite | null { return this.gunCtl.muzzleFlash; }
  get gunUnit(): number { return this.gunCtl.unit; }
  get gunBaseY(): number { return this.gunCtl.baseY; }
  get gunBaseZ(): number { return this.gunCtl.baseZ; }
  get gunRestX(): number { return this.gunCtl.restX; }
  get gunBaseX(): number { return this.gunCtl.baseX; }
  get gunKickZ(): number { return this.gunCtl.kickZ; }
  get gunBaseQuat(): THREE.Quaternion | null { return this.gunCtl.baseQuat; }
  lastRoll = 0;
  private handBone: THREE.Bone | null = null;
  private mountBone: THREE.Bone | null = null;
  private handBoneL: THREE.Bone | null = null;
  // Damage flash — same white-pop the creatures do (flash timer × brighter
  // surface). Skinned materials can't use instanceColor, so we lerp each
  // material's emissive toward white and back from a cached baseline.
  /** Emissive materials captured at load for the damage white-pop —
   *  ModelFx reads this straight through the host. */
  get flashMats(): { m: THREE.MeshStandardMaterial; e: THREE.Color; i: number }[] { return this.mats.flashMats; }
  private fx = new ModelFx(this);

  // ---- Retargeted UAL clips ------------------------------------------
  // Fetch/parse/bake caches live in playerUal.ts; this class only wires
  // the baked clip table into its own mixer once it resolves.
  private currentClipName: string | null = null;
  private playingUAL = false;

  // ---- Gibs: real body parts for the death shatter ---------------------
  // Grouped at load, baked posed on death — logic lives in playerGibs.ts.
  private gibParts: GibPart[] | null = null;

  /** Posed body-part fragments at the corpse's current stance — recentered
   *  chunk geometries + their world centroids. Null until loaded / if the
   *  model has no skinned meshes (caller falls back to generic debris). */
  deathParts(): { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] | null {
    if (!this.gibParts && this.model) {this.gibParts = buildGibParts(this.model);}
    if (!this.gibParts || !this.model) {return null;}
    return bakeDeathParts(this.model, this.gibParts);
  }

  /** 'robot' = RobotExpressive + retargeted UAL clips (backburner path).
   *  'mannequin' = the UAL's own rig — clips play natively, no retarget.
   *  'knight' = Quaternius Knight_Male — the heavy-class silhouette;
   *  native clips, armored read at distance.
   *  'scifisoldier'/'vexa'/'polyart' = the UAS class bodies —
   *  each bakes its own clip set on its own rig (vexa ships
   *  none, it stands static until a clip'd medium replaces it). */
  readonly variant: PlayerModelVariant;
  // Two classes share the mannequin rig — the rev flag gives one of them
  // the inverse material swap so they don't read identical.
  readonly mannRev: boolean;

  constructor(scene: THREE.Scene, variant?: PlayerModelVariant, mannRev = false) {
    this.scene = scene;
    this.variant = variant ?? (urlParams.get('model') === 'mannequin' ? 'mannequin' : 'robot');
    this.mannRev = mannRev;
    this.pose = new PoseControl(this.variant);
    // Native shoot clips carry a self-consistent torso stance — the bind
    // slerp only helps UAL-retargeted clips whose stride roll waves the
    // muzzle (see PoseControl.wantSpineLock).
    const shootClip = CLASS_BODY_SPEC[this.variant]?.anims?.['shoot'];
    this.pose.wantSpineLock = !shootClip || shootClip.startsWith('UAL_');
    // The gun controller owns the mesh; a baked-geo swap invalidates the
    // wireframe capture, so it reaches back through this hook.
    this.gunCtl.onGeoSwap = () => { if (this.mats.wireframeOn) {this.mats.captureWireframe(this.model);} };
  }

  async load(): Promise<void> {
    const loader = mkGltfLoader();
    const mann = this.variant === 'mannequin';
    const knight = this.variant === 'knight';
    const url = RIG_MANIFEST[this.variant]?.url ?? '/assets/models/RobotExpressive.glb';

    return new Promise((resolve, reject) => {
      let attempts = 0;
      let fellBack = false;
      const attempt = () => {
      // One parse per rig URL for the whole session — SkeletonUtils.clone
      // hands each remote its own skeleton bound to shared geometry and
      // textures. A roomful of same-class bots used to pay a full GLB
      // decode + GPU upload apiece.
      loadGltfCached(loader, url).then(
        (gltf) => {
          if (this._disposed) { resolve(); return; }
          this.onModelLoaded({ scene: SkeletonUtils.clone(gltf.scene) as THREE.Group, animations: gltf.animations.map((c) => c.clone()) }, mann, knight);
          resolve();
        },
        (error) => {
          // A dev-server restart (or any transient fetch failure) must not
          // kill the model for the whole session — an invisible player is
          // worse than a late one. Retry with backoff before giving up.
          if (this._disposed) { resolve(); return; }
          if (++attempts <= 4) {
            logger.warn(`Model load failed, retry ${attempts}/4`, error);
            setTimeout(attempt, 600 * attempts);
            return;
          }
          // A rig absent from the deploy bundle (clean builds strip the
          // class_* GLBs) permanently 404s — retrying can't help, so swap
          // the variant once for a body the bundle always ships.
          if (!fellBack && url.includes('/class_')) {
            fellBack = true;
            logger.warn('Rig missing from bundle, using fallback body', { variant: this.variant });
            (this as { variant: PlayerModelVariant }).variant = this.variant === 'polyart' ? 'knight' : 'mannequin';
            this.pose = new PoseControl(this.variant);
            const fbShoot = CLASS_BODY_SPEC[this.variant]?.anims?.['shoot'];
            this.pose.wantSpineLock = !fbShoot || fbShoot.startsWith('UAL_');
            this.load().then(resolve, reject);
            return;
          }
          logger.error('Failed to load', error);
          reject(error);
        }
      );
      };
      attempt();
    });
  }

  private onModelLoaded(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }, mann: boolean, knight: boolean): void {
    this.model = gltf.scene;

    // Log model bounding box for hitbox calibration. `precise` bakes
    // skinned vertices — quantized rigs (class_heavy's int16 attrs)
    // otherwise report the normalized attribute box (~±1) instead of
    // the posed size and the fit math explodes the model ~100x. The
    // skeleton has to be posed for the bake to mean anything.
    this.model.updateMatrixWorld(true);
    this.model.traverse((c) => (c as THREE.SkinnedMesh).skeleton?.update());
    const box = new THREE.Box3().setFromObject(this.model, true);
    const size = box.getSize(new THREE.Vector3());
    const {min} = box;
    const {max} = box;
    logger.debug(`Model bounding box: size=(${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)}) min=(${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}) max=(${max.x.toFixed(2)},${max.y.toFixed(2)},${max.z.toFixed(2)})`);

    // Enable shadow casting + grab aim/attachment bones
    this.model.traverse((child) => this.prepareChild(child));
    this.computeDistalBones();
    // Model may finish loading while a far-LOD swap is already armed —
    // the freshly captured skinnedMeshes need the swap applied now.
    if (this.lodCtl.lod === 1) {this.lodCtl.apply();}
    logger.debug(`Aim bones: ${this.pose.aimBoneNames()} | hand: ${this.handBone?.name ?? 'NONE'}`);

    // Scale and rotate to match our coordinate system
    // Model bounding box at scale 1.0: x: 3.2, y: 4.8, z: 3.2
    // At scale 0.5: x: 1.6, y: 2.4, z: 1.6
    // Hitbox: radius 0.8 (width 1.6), height 2.0
    // Scale factor 0.5 matches width, but model is taller (2.4 vs 2.0)
    // RobotExpressive.glb origin is at feet (y=0), not center
    const classBody = CLASS_BODY_SPEC[this.variant];
    const rig = RIG_MANIFEST[this.variant];
    const scale = rig?.fitH === undefined ? (rig?.fixedScale ?? 0.5) : rig.fitH / size.y; // class bodies fit their capsule eye height — the body IS the class silhouette
    this.model.scale.setScalar(scale);
    this.model.rotation.y = rig?.yaw ?? Math.PI; // Face forward
    this.modelScale = scale;
    // Some rigs don't author their origin at the feet — setPosition
    // re-lands the mesh's lowest point on the logical feet each frame.
    this.feetOffsetY = -min.y * this.modelScale;
    this.model.position.y = this.feetOffsetY;

    // Procedural gun: bone-mounted on rigs whose bones match the
    // rendered body (mannequin/robot), socket-mounted on class bodies
    // whose armature frames don't (cyber's bones sit ~98 units off).
    if (this.handBone || classBody?.gunLocal) {this.attachGun();}
    else {logger.warn('GUN NOT ATTACHED — no hand bone or gun socket');}

    // No Y offset needed — model origin is already at feet

    // Mixer + clip table live in the anim controller. Mannequin clips
    // ARE the UAL clips natively — registerClip aliases them under the
    // UAL_ names the state map prefers so ANIM_NAMES resolves without a
    // retarget pass.
    this.anim.attach(this.model);
    for (const clip of gltf.animations) {this.anim.registerClip(clip, mann, knight, this.rootMotionNodes());}
    if (CLASS_BODY_SPEC[this.variant]) {this.anim.alignHipYaw();}
    // Any variant whose clips carry Pistol_Aim_* gets the masked layer —
    // mk() no-ops when the rig ships none (polyart, vexa). Mannequin gets
    // the torso mask too: its locomotion clips yield spine/head quats at
    // bake (same mask), so the aim pose owns the torso outright — no
    // residual stride roll swinging the muzzle.
    this.pose.buildAimLayer(this.anim.mixer!, this.anim.animations, mann);

    logger.debug('Loaded animations:', Array.from(this.anim.animations.keys()));

    this.anim.markLoaded();

    // Retargeted UAL clips arrive async — a native clip plays until
    // they land, then the current state re-resolves onto the better
    // clip. Cached globally so only the first model pays the bake.
    // The mannequin binds UAL clips natively and the knight ships
    // its own set — neither pays a retarget pass.
    // Robot bakes the full UAL set; the mannequin bakes the KevDev
    // directional locomotion only (its UAL clips ship natively — the
    // variants filter in playerUal skips the artifact-prone UAL2 pass).
    // Knight/scifisoldier/polyart are native-only (their own rigs carry
    // their own clip sets). Cybersoldier ships zero clips — it bakes the
    // mannequin's state set AND the kevdev directionals; vexa bakes
    // kevdev locomotion under her native states.
    if ((RIG_MANIFEST[this.variant]?.sources.length ?? 0) > 0) {this.anim.retargetUAL();}

    this.scene.add(this.model);
    if (this._detached) {this.scene.remove(this.model);}
    logger.debug('MODEL ADDED to scene', { children: this.scene.children.length });

    // Collider gizmo (wireframe capsule for hitbox visualization) —
    // playerCollider.ts builds it against the FULL visual scale so
    // setScale() can't inflate the wire past the real sim capsule.
    this.collider.attach(this.model, this.modelScale * this._visScale, this.feetOffsetY);
  }

  // Per-node load prep: mesh shadows/frustum fix + flash material capture,
  // then rig-bone capture (aim chain, hand grip, foot-snap helpers).
  private prepareChild(child: THREE.Object3D): void {
    if (child instanceof THREE.Mesh) {this.prepareMesh(child);}
    if ((child as THREE.Bone).isBone) {this.captureBone(child);}
  }

  private skinnedMeshes: THREE.SkinnedMesh[] = [];
  private readonly lodCtl = new PlayerModelLod(this.skinnedMeshes,
    () => mkGltfLoader().loadAsync(RIG_MANIFEST[this.variant].lodUrl!).then((g) => {
      const geos: THREE.BufferGeometry[] = [];
      g.scene.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) {geos.push(smoothShade((o as THREE.SkinnedMesh).geometry));}
      });
      return geos;
    }));

  /** setScale() multiplier on top of the rig fit — the collider gizmo
   *  divides by this too so the debug wire stays at the sim capsule. */
  private _visScale = 1;
  /** Re-size the debug gizmo to the class hit capsule — the gizmo was
   *  built from the generic constants and never matched light/heavy sim
   *  capsules. */
  setColliderCapsule(cap: { height: number; half: number; radius: number }): void {
    this.collider.setCapsule(cap, this.modelScale * this._visScale, this.feetOffsetY);
  }

  /** Distant remotes shouldn't pay the skinned shadow-pass vertex cost —
   *  nobody reads a 200m figure's cast shadow. */
  setCastShadow(on: boolean): void {
    for (const m of this.skinnedMeshes) {m.castShadow = on;}
  }

  // Progressive bone LOD (distal-bone freeze + far-clip track filtering)
  // lives in playerDistal.ts — the bone census feeds it, the action swap
  // on freeze comes back through setDistalFrozen.
  readonly distal = new PlayerDistal(); // public — PlayerAnim host surface

  setBonesFrozen(frozen: boolean): void {
    this.distal.setBonesFrozen(frozen);
  }

  private computeDistalBones(): void {
    this.distal.compute([this.handBone ?? undefined, ...this.pose.keyBones()], this.model);
    // Model may finish loading while a far LOD is already armed.
    if (this.distal.frozen) {this.setDistalFrozen(true);}
  }

  setDistalFrozen(frozen: boolean): void {
    const next = this.distal.setFrozen(frozen, { action: this.anim.currentAction && this.anim.currentClipName ? this.anim.currentAction : null }, this.anim.mixer!);
    if (next) {this.anim.currentAction = next;}
  }

  /** Far-LOD swap: mannequin_lod1.glb is the same rig decimated ~80% —
   *  geometry carries the skin weights, so swapping geo alone keeps the
   *  pose. The skeleton/mixer is untouched. Only exists for 'mannequin'. */
  setLod(level: 0 | 1): void {
    // The decimated rig is mannequin-only — LOD-swapping it onto a class
    // body would graft mannequin geometry onto a foreign skeleton.
    if (this.variant !== 'mannequin') {return;}
    this.lodCtl.set(level);
  }

  // Mannequin reskin, per-instance material clones (a flash mutating a
  // shared GLB material would light up the whole fleet), emissive
  // capture, and the debug wireframe set live in playerMats.ts.
  private readonly mats = new PlayerMats();

  private prepareMesh(child: THREE.Mesh): void {
      child.castShadow = true;
      child.receiveShadow = true;
      child.geometry = smoothShade(child.geometry);
      // Reskin + per-instance clone + emissive capture — playerMats.ts
      this.mats.prep(child, this.variant === 'mannequin', this.mannRev);
      // SkinnedMesh bind-pose bounds don't track bone-driven verts —
      // wrong bounds get it frustum-culled when it shouldn't be. Compute
      // the skinned bounds at load (three walks verts through the
      // skeleton) and pad for anim travel so culling can come back on.
      if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
        const sk = child as THREE.SkinnedMesh;
        this.skinnedMeshes.push(sk);
        sk.computeBoundingSphere();
        if (sk.boundingSphere) {sk.boundingSphere.radius += 0.6;}
      }
    }

  // Name-based since the model also has same-named plain nodes; only real
  // Bones qualify. Mannequin bones are DEF-* (normBone-stripped compare).
  private captureBone(child: THREE.Object3D): void {
    this.distal.captureBone(child as THREE.Bone);
    const nb = normBone(child.name);
    // GLTFLoader sanitizes names ('Palm2.R' -> 'Palm2R'); the
    // Quaternius rigs put the grip in FistR.
    if ((child.name === 'Palm2R' || nb === 'defhandr' || nb === 'fistr'
      || nb === 'handr' || nb === 'handright'
      || nb === 'rigpistolright' || nb === 'rigarmright3'
      || nb === 'basehumanrpalm') && !this.handBone) {
      this.handBone = child as THREE.Bone;
    }
    // Foregrip palm — palm-line mounts orient the barrel along
    // grip→foregrip, so both hands must resolve.
    if ((child.name === 'Palm2L' || nb === 'defhandl' || nb === 'fistl'
      || nb === 'handl' || nb === 'handleft'
      || nb === 'rigarmleft3' || nb === 'rigleftpistol'
      || nb === 'basehumanlpalm') && !this.handBoneL) {
      this.handBoneL = child as THREE.Bone;
    }
    const mbn = RIG_MANIFEST[this.variant]?.mount?.bone;
    if (mbn && nb === mbn) {this.mountBone = child as THREE.Bone;}
    this.pose.captureBone(child, nb);
    if (child.name === 'FootL' || child.name === 'FootR') {this.pose.captureFootBone(child, this.model!);}
  }

  // Procedural gun in the right hand — follows every animation.
  // The gun group/mount/follow all live in playerGun.ts; this wrapper
  // only decides whether a mount exists and sets the pose flags the
  // mount choice implies.
  private attachGun(): void {
    const classGun = CLASS_BODY_SPEC[this.variant]?.gunLocal;
    const handBone = this.mountBone ?? this.handBone;
    if (!handBone && !classGun) {return;}
    // Socket rigs without native armed anims get the canned grip pose;
    // `armedHold` extends it to rigs whose own clips carry low-ready
    // (scifisoldier's *_Rifle set) but should ride the hip-fire grip in
    // every state — including through Fire_* oneshots.
    const armedHold = Boolean(RIG_MANIFEST[this.variant]?.armedHold);
    this.pose.wantHoldPose = (armedHold || !CLASS_BODY_SPEC[this.variant]?.anims) && Boolean(handBone);
    this.pose.holdShoots = armedHold;
    this.pose.holdIdle = Boolean(RIG_MANIFEST[this.variant]?.idleHold) && Boolean(handBone);
    this.gunCtl.attach({
      handBone, handBoneL: this.handBoneL,
      mount: RIG_MANIFEST[this.variant]?.mount,
      model: this.model!, modelScale: this.modelScale, feetOffsetY: this.feetOffsetY,
      classGun,
    });
  }

  // Nodes above the hips that authored rigs animate as root motion —
  // computed from the loaded hierarchy once per model.
  private _rootMotionNodes: Set<string> | null = null;

  private rootMotionNodes(): Set<string> {
    if (!this._rootMotionNodes) {
      this._rootMotionNodes = this.model ? computeRootMotionNodes(this.model) : new Set();
    }
    return this._rootMotionNodes;
  }

  // The whole clip-drive surface delegates to playerAnim.ts — signatures
  // preserved for PlayerVisuals/remoteAnim/gunlab/posedump callers.
  playAnimation(name: string, startPhase = 0): void { this.anim.playAnimation(name, startPhase); }

  setLocomotionVector(fwd: number, side: number): boolean { return this.anim.setLocomotionVector(fwd, side); }

  setLocomotionReversed(rev: boolean): void { this.anim.setLocomotionReversed(rev); }

  get animationState(): AnimationState { return this.anim.currentState; }

  setAnimationState(state: AnimationState): void { this.anim.setAnimationState(state); }

  forceAnimationState(state: AnimationState, keepPhase = false): void { this.anim.forceAnimationState(state, keepPhase); }

  update(dt: number): void {
    this.anim.tick(dt);
    this.gunCtl.follow(dt, this.model, this.modelScale, this.handBoneL);
    this.fx.tick(dt);
    this.auditStretch(dt);
  }

  // Stretch canary — the exploded-rig bug smears verts between bones that
  // should sit ~2m apart; visAudit only samples at dump time, so a
  // transient mid-clip stretch never lands in the paste. Every 0.5s
  // (staggered per model) measure the skeleton's max world-space spread —
  // >8m on a ≤2.8m body is impossible geometry. glitch() records the
  // variant + clip + state so the Alt+Q glitch census names the
  // animation that did it.
  private stretchAt = Math.random() * 0.5;
  private auditStretch(dt: number): void {
    this.stretchAt -= dt;
    if (this.stretchAt > 0) {return;}
    this.stretchAt = 0.5;
    if (!this.model || !this.model.visible || this.skinnedMeshes.length === 0) {return;}
    this.model.updateMatrixWorld(true);
    let maxSq = 0, bi = -1, bj = -1;
    const mesh0 = this.skinnedMeshes[0];
    for (const sm of this.skinnedMeshes) {
      const {bones} = sm.skeleton;
      for (let i = 0; i < bones.length; i += 1) {
        const a = bones[i].matrixWorld.elements;
        for (let j = i + 1; j < bones.length; j += 1) {
          const b = bones[j].matrixWorld.elements;
          const dx = a[12] - b[12], dy = a[13] - b[13], dz = a[14] - b[14];
          const d = dx * dx + dy * dy + dz * dz;
          if (d > maxSq) { maxSq = d; bi = i; bj = j; }
        }
      }
    }
    if (maxSq > 64) {
      const bn = mesh0 && bi >= 0 ? `${mesh0.skeleton.bones[bi]?.name}↔${mesh0.skeleton.bones[bj]?.name}` : '?';
      glitch('model-stretch', {
        variant: this.variant,
        clip: this.anim.currentClipName ?? '?',
        state: this.anim.currentState,
        spread: Math.round(Math.sqrt(maxSq)),
        bones: bn,
      });
    }
  }

  /** Barrel-tip world point — third-person beam/tracer anchor. */
  muzzleWorld(out: THREE.Vector3): boolean {
    return this.gunCtl.muzzleWorld(out);
  }

  // Recoil: exponential decay kick on the gun (position + muzzle flip);
  // muzzle flash is a ~90ms pop decaying on the same curve.
  /** Third-person weapon swap — the same lower→switch→raise the
   *  viewmodel plays (its timings: 0.12s down, 0.16s up). */
  weaponSwap(): void { this.fx.weaponSwap(); }
  weaponThrow(): void { this.fx.weaponThrow(); }
  weaponPunch(): void { this.fx.weaponPunch(); }
  landPulse(impactSpeed: number): void { this.fx.landPulse(impactSpeed); }

  /** Swap the hand prop to the real weapon's silhouette. The wire only
   *  reveals a remote's weapon when they use it (playerShot/kill feed),
   *  so types without a baked model — or not yet seen firing — keep the
   *  generic prop rather than guess wrong. */
  setWeapon(wt: number | undefined): void {
    if (wt === undefined) {return;}
    this.gunCtl.setWeapon(wt);
  }

  /** Damage white-pop — creature-style hit readability on the robot body. */
  damageFlash(): void { this.fx.damageFlash(); }

  // Procedural fire kick + muzzle flash — call when the remote player shoots.
  fire(weaponType?: number): void {
    this.pose.fire();
    // A shot reveals the held weapon — swapping the prop first means the
    // muzzle flash frames the right barrel.
    if (weaponType !== undefined && weaponType !== WeaponType.Melee) {this.setWeapon(weaponType);}
    this.fx.fire(weaponType);
  }

  setPosition(x: number, y: number, z: number): void {
    if (this.model) {
      // Position represents feet; feetOffsetY lifts rigs whose authored
      // origin isn't at their feet so capsule bottom == mesh bottom.
      this.model.position.set(x, y + this.feetOffsetY, z);
    }
    // Collider gizmo is a child of the model, so it moves with it automatically
  }

  /** Where the rendered body actually is (feet) — null before the GLB
   *  loads. The bot watchdog diffs this against the logical position to
   *  catch a stalled tick/interpolation path. */
  getModelPosition(out: THREE.Vector3): boolean {
    if (!this.model) {return false;}
    out.copy(this.model.position);
    out.y -= this.feetOffsetY;
    return true;
  }

  /** Directional body lean (jet thrust tilt): pitch = forward/back,
   *  roll = sideways. Set every frame a jet is active; pass 0,0 to ease
   *  back to level. Applied to the whole model so it composes with
   *  whatever clip is playing — TA-style directional jetting reads from
   *  body tilt, not a per-direction clip set (UAL has none). */
  setBodyLean(pitch: number, roll: number): void { this.fx.setBodyLean(pitch, roll); }

  setRotation(yaw: number, pitch: number, roll: number = 0): void {
    if (this.model) {
      // YXZ so lean pitch/roll resolve in the yawed (facing) frame.
      if (this.model.rotation.order !== 'YXZ') {this.model.rotation.order = 'YXZ';}
      this.model.rotation.y = yaw + (RIG_MANIFEST[this.variant]?.yaw ?? 0);
      this.lastRoll = roll;
      this.model.rotation.z = roll;
      this.pose.aimPitch = pitch;
      // Don't apply pitch to body — it's an aiming angle, not body orientation.
      // It goes to the head bone in update(), after the mixer writes the pose.
    }
  }

  setVisible(visible: boolean): void {
    if (this.model) {
      this.model.visible = visible;
    }
  }

  /** The ~300-node rig (mostly bones) costs traversal in updateMatrixWorld
   *  and projectObject even while invisible — detaching is the only prune,
   *  since matrixAutoUpdate flags don't stop the walk. Offscreen remotes
   *  detach; stale matrixWorlds correct themselves on re-add. */
  setSceneDetached(detached: boolean): void {
    this._detached = detached;
    if (!this.model) {return;}
    if (detached) {this.scene.remove(this.model);}
    else {this.scene.add(this.model);}
  }
  private _detached = false;

  // Ghost shimmer — translucent material SWAP for the decloak-reveal.
  // The meshes' real materials ride in ghostBaseline while each source
  // mat resolves to one shared translucent variant, so nothing ever gets
  // mutated — baked/GLB mats serve every model and the viewmodel palette
  // alike, and mutating them would shimmer every gun in the client. This
  // is also why hand-prop mats never need per-model clones.
  private ghostBaseline: Map<THREE.Mesh, THREE.Material | THREE.Material[]> | null = null;
  private static ghostVariants = new Map<THREE.Material, THREE.Material>();
  private static ghostOf(m: THREE.Material): THREE.Material {
    let g = this.ghostVariants.get(m);
    if (!g) {
      g = m.clone();
      g.transparent = true;
      g.opacity = 0.28;
      g.depthWrite = false;
      PlayerModel.ghostVariants.set(m, g);
    }
    return g;
  }
  setGhost(on: boolean): void {
    if (!this.model) {return;}
    if (on) {
      if (this.ghostBaseline) {return;}
      this.ghostBaseline = new Map();
      this.model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) {return;}
        this.ghostBaseline!.set(mesh, mat);
        mesh.material = Array.isArray(mat) ? mat.map((m) => PlayerModel.ghostOf(m)) : PlayerModel.ghostOf(mat);
      });
      return;
    }
    if (!this.ghostBaseline) {return;}
    for (const [mesh, mat] of this.ghostBaseline) {mesh.material = mat;}
    this.ghostBaseline = null;
  }

  /** Friend-or-foe tint on the debug hitbox — remotes recolor on team
   *  assign; untouched models stay the default friendly green. The hex is
   *  cached so a call landing before the GLB load still tints the capsule
   *  when it's built. */
  setColliderColor(hex: number): void { this.collider.setColor(hex); }

  /** Debug (?debug / menu DEBUG): render the body as wireframe so it can
   *  be eyeballed against the collider capsule. */
  setWireframe(on: boolean): void { this.mats.setWireframe(on, this.model); }

  setColliderVisible(visible: boolean, force = false): void {
    this.collider.setVisible(visible, force);
  }

  removeColliderGizmo(): void {
    this.collider.remove(this.model);
  }

  addColliderGizmo(): void {
    if (this.model) {this.collider.reattach(this.model);}
  }

  setScale(scale: number): void {
    // Class bodies carry the class silhouette in the GLB itself — a
    // _classScale bump on top would double the tiering.
    if (CLASS_BODY_SPEC[this.variant]) {return;}
    this._visScale = scale;
    if (this.model) {
      // Multiply the model's own fit scale (0.5 robot, 2.0/size.y mannequin)
      // so the armor-class bump composes with whichever GLB loaded.
      this.model.scale.setScalar((this.modelScale || 0.5) * scale);
      // The gizmo is a child of the scaled root — rebuild it so the wire
      // still traces the sim capsule, not the bumped silhouette.
      if (this.collider.attached) {
        this.setColliderCapsule(this.collider.cap ?? {
          height: CAPSULE_CENTER_Y * 2, half: CAPSULE_CYLINDER_HEIGHT / 2, radius: PLAYER_RADIUS,
        });
      }
    }
  }

  dispose(): void {
    logger.debug('DISPOSE called');
    this._disposed = true;
    if (this.model) {
      this.scene.remove(this.model);
      logger.debug('MODEL REMOVED from scene');
      this.anim.dispose();
      this.model = null;
      this.gibParts = null; // just (mesh, indices) — nothing GPU-owned here
      this.mats.dispose();
    }
    this.collider.dispose();
  }
}
