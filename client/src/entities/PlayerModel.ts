import * as THREE from 'three';
import { mkGltfLoader, loadGltfCached } from '../gltfLoad';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

import { PLAYER_RADIUS, CAPSULE_CYLINDER_HEIGHT, CAPSULE_CENTER_Y } from '../core/config.js';
import { urlParams } from '../core/params.js';

import { ChildLogger } from '../core/Logger.js';
import { buildGibParts, bakeDeathParts, type GibPart } from './playerGibs.js';

const logger = new ChildLogger('PlayerModel');

// Several body GLBs ship flat normals (per-face corners) — the robot
// reads faceted because it IS faceted. toCreasedNormals re-averages
// normals across coplanar verts: curvature goes smooth, edges past the
// 60° crease stay hard. One pass per geometry — GLBs share geo across
// meshes, so cache by source.
const _creased = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
const _gunV = new THREE.Vector3();
const _gunQ = new THREE.Quaternion();
const _gunMQ = new THREE.Quaternion();
const _gunPalmL = new THREE.Vector3();
const _gunDir = new THREE.Vector3();
const _gunUp = new THREE.Vector3(0, 1, 0);
const _gunLook = new THREE.Matrix4();
const _gunQ2 = new THREE.Quaternion();
const _gunQYaw = new THREE.Quaternion();

function smoothShade(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  let g = _creased.get(geo);
  if (!g) { g = toCreasedNormals(geo); _creased.set(geo, g); }
  return g;
}
// Locomotion clip surgery (stripHipXZ/dampenSway/DIR8) lives in
// playerClipSurgery.ts — extracted so the layered-anim carve-up is
// testable without loading the rig.

export type { AnimationState } from './playerClips.js';
import { ONESHOT_CLIPS, clipCandidates,
  CLASS_BODY_SPEC, CLASS_BODY_DEATH_CLIPS, RIG_MANIFEST,
  normBone, type AnimationState } from './playerClips.js';
import { DIR8, stripHipXZ, dampenSway, computeRootMotionNodes,
  isLayeredClip, AIM_BONE_MASK, AIM_TORSO_BONES, SWAY_BONES, clampHipY, type LocoDir } from './playerClipSurgery.js';
import { ModelFx } from './modelFx.js';
import { PoseControl } from './playerPose.js';
import { bakeUALClips, loadBakedUALClips } from './playerUal.js';
import { handWeaponGeo } from './handWeapons.js';
import { metalMat } from './procMetal.js';
import { WeaponType } from '../../../shared/weapons.js';

export type PlayerModelVariant = 'robot' | 'mannequin' | 'knight' | 'scifisoldier' | 'cybersoldier' | 'vexa' | 'polyart';

// Mannequin re-skin (cached shared recipes — each PlayerModel still
// clones via ownMaterial so damage-flash stays per-instance).
// mannGunMat = the prop-gun recipe (joints), mannJointMat = pickup
// gunmetal (torso).
let _mannGun: THREE.MeshStandardMaterial | null = null;
let _mannMetal: THREE.MeshStandardMaterial | null = null;
function mannGunMat(): THREE.MeshStandardMaterial {
  if (!_mannGun) {
    _mannGun = new THREE.MeshStandardMaterial({ color: 0x2A_2E_33, roughness: 0.55, metalness: 0.6, emissive: 0x33_44_55, emissiveIntensity: 0.8 });
  }
  return _mannGun;
}
function mannJointMat(): THREE.MeshStandardMaterial {
  if (!_mannMetal) {_mannMetal = metalMat();}
  return _mannMetal;
}

// A missing clip is authored into the GLB — the variant's whole fleet
// misses the same set, so the dedupe is (variant, clip) per session,
// not per model instance. 20 bots of one rig warn once, not 20 times.
const warnedAnimMisses = new Set<string>();

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
  private _warnedAnims = warnedAnimMisses;

  // Read-only access to the loaded object3D (debug tooling)
  get object3D(): THREE.Group | null { return this.model; }
  private mixer: THREE.AnimationMixer | null = null;
  private animations: Map<string, THREE.AnimationAction> = new Map();
  private _loaded = false;
  // Requests that arrive before the GLB lands — anim state still applies
  // on load instead of warning against an empty map.
  private _queuedAnim: string | null = null;
  private currentAction: THREE.AnimationAction | null = null;
  /** Manual weight ramps, stepped in update(). three's fadeIn/fadeOut
   *  hardcode interpolant endpoints 0→1 / 1→0 regardless of live weight,
   *  so re-firing an action mid-transition snaps its weight to 0 — and a
   *  sub-1 coverage frame mixes toward bind pose (the T-pose flash on
   *  spam). These fades ramp from the action's live weight instead. */
  private fades = new Map<THREE.AnimationAction, {
    from: number; to: number; t: number; dur: number;
  }>();
  private fadeAction(a: THREE.AnimationAction, to: number, dur: number): void {
    a.stopFading();
    this.fades.set(a, {
      from: a.getEffectiveWeight(), to, t: 0,
      dur: Math.max(dur, 1e-4),
    });
  }
  private currentState: AnimationState = 'idle';
  // Facing-frame locomotion direction, quantized to 8 sectors — feeds the
  // KevDev directional clip table when state is 'walk'/'run'.
  private locoDir: LocoDir = 'F';
  /** True while a dedicated directional clip drives the current action —
   *  callers skip the reverse-playback/strafe-lean fallbacks then. */
  dirClipActive = false;
  private colliderGizmo: THREE.Mesh | null = null;
  private colliderMat: THREE.MeshBasicMaterial | null = null;
  private colliderHex = 0x00FF00;
  // Post-mixer pose corrections (aim pitch, hip-fire hold, spine lock,
  // IK foot snap) live in playerPose.ts — PoseControl owns the bone
  // lists it writes into.
  private pose: PoseControl;

  /** Live-tune the hand-bone mount rotation (posedump loop) — deg euler. */
  debugSetGunRot(x: number, y: number, z: number): void {
    this.gun?.rotation.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180);
  }

  /** Live-tune the hold pose (posedump iteration loop) — deg per role. */
  debugSetHold(upper: [number, number, number], lower: [number, number, number], hand: [number, number, number], lUpper: [number, number, number] = upper.map(v => -v) as [number, number, number], lLower: [number, number, number] = lower, lHand: [number, number, number] = hand): void {
    this.pose.debugSetHold(upper, lower, hand, lUpper, lLower, lHand);
  }
  // Weapon-swap dip — mirrors the first-person viewmodel's lower→raise:
  // the held gun drops toward the hip and the muzzle tips down, then the
  // "new" weapon comes back up. Purely cosmetic on the body model (the
  // prop gun doesn't change), but the motion is the readable swap tell.
  // Prop-gun transform + lean roll live on the model — the FX pass
  // (modelFx.ts) reads/writes them through the ModelFxHost surface.
  gunUnit = 1; // 1 world meter in bone-space units (1/ws.x)
  gunBaseY = 0;
  lastRoll = 0;
  private handBone: THREE.Bone | null = null;
  private mountBone: THREE.Bone | null = null;
  // Bone-mounted gun: world scale is renormalized every update — rigs
  // like polyart carry non-uniform armature scale that shifts with the
  // pose, so a one-time per-axis divide still let the prop stretch
  // needle-thin (the "sword" gun).
  private gunMountBone: THREE.Object3D | null = null;
  private gunSize = 0.7;
  private gunMountPos: [number, number, number] = [0, 0, 0];
  private gunMountQuat: THREE.Quaternion | null = null;
  private handBoneL: THREE.Bone | null = null;
  private palmsMount = false;
  private gunPalmFwd = 0;
  private gunPalmFlip = false;
  private gunPalmYaw = 0;
  private gunPalmUp = 0;
  gun: THREE.Group | null = null;
  private gunMesh: THREE.Mesh | null = null;
  private heldWeapon = -1;
  gunBaseZ = 0;
  gunRestX = 0; // socket-mounted guns park at a lateral offset
  gunBaseX = 0; // mannequin attach pitch — recoil adds on top
  gunKickZ = 0;
  gunBaseQuat: THREE.Quaternion | null = null;
  private socketGun = false;
  muzzleFlash: THREE.Sprite | null = null;
  // Damage flash — same white-pop the creatures do (flash timer × brighter
  // surface). Skinned materials can't use instanceColor, so we lerp each
  // material's emissive toward white and back from a cached baseline.
  flashMats: { m: THREE.MeshStandardMaterial; e: THREE.Color; i: number }[] = [];
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
    if (this.lod === 1) {this.applyLodGeos();}
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

    // Set up animation mixer
    this.mixer = new THREE.AnimationMixer(this.model);

    // Store animations with mapping. Mannequin clips ARE the UAL
    // clips natively — alias them under the UAL_ names the state map
    // prefers so ANIM_NAMES resolves without a retarget pass.
    for (const clip of gltf.animations) {this.registerClip(clip, mann, knight);}
    if (CLASS_BODY_SPEC[this.variant]) {this.alignHipYaw();}
    // Any variant whose clips carry Pistol_Aim_* gets the masked layer —
    // mk() no-ops when the rig ships none (polyart, vexa). Mannequin gets
    // the torso mask too: its locomotion clips yield spine/head quats at
    // bake (same mask), so the aim pose owns the torso outright — no
    // residual stride roll swinging the muzzle.
    this.pose.buildAimLayer(this.mixer!, this.animations, mann);

    logger.debug('Loaded animations:', Array.from(this.animations.keys()));

    this._loaded = true;
    // Start with whatever the last request was (remotes spawn mid-
    // load and ask for Running/Walking before the mixer exists). The
    // default goes through the state table — a bare 'Idle' name only
    // exists on knight's rig, other variants resolve their own idle.
    if (this._queuedAnim) {this.playAnimation(this._queuedAnim);}
    else {this.forceAnimationState('idle');}
    this._queuedAnim = null;

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
    if ((RIG_MANIFEST[this.variant]?.sources.length ?? 0) > 0) {this.retargetUAL();}

    this.scene.add(this.model);
    logger.debug('MODEL ADDED to scene', { children: this.scene.children.length });

    // Create collider gizmo (wireframe capsule for hitbox visualization)
    // Uses same constants as collision detection — single source of truth in config.ts
    // CapsuleGeometry(radius, cylinderHeight, ...) — cylinderHeight excludes hemispheres
    // Divide by the FULL visual scale (rig fit × class bump) — the gizmo
    // is a model child, so setScale() would otherwise inflate the wire
    // past the real sim capsule.
    const cap = this.colliderCap;
    const vs = this.modelScale * this._visScale;
    const colliderGeo = new THREE.CapsuleGeometry(
      (cap ? cap.radius : PLAYER_RADIUS) / vs,
      (cap ? 2 * cap.half : CAPSULE_CYLINDER_HEIGHT) / vs,
      4, 16);
    this.colliderMat = new THREE.MeshBasicMaterial({
      color: this.colliderHex,
      wireframe: true,
      transparent: true,
      opacity: 0.3,
      depthTest: false // Always render on top
    });
    this.colliderGizmo = new THREE.Mesh(colliderGeo, this.colliderMat);
    // Capsule center is at feet + CAPSULE_CENTER_Y (half PLAYER_HEIGHT).
    // feetOffsetY lifts the whole group for rigs not authored feet-at-origin
    // — the gizmo counteracts it locally so it stays on the logical feet.
    this.colliderGizmo.position.y = (cap ? cap.height / 2 : CAPSULE_CENTER_Y) / vs - this.feetOffsetY;
    this.colliderGizmo.renderOrder = 999; // Render last (on top)
    // Hitbox visualization is a debug overlay — same flag as the
    // AOE blast wireframes (menu DEBUG toggle / ?debug).
    this.colliderGizmo.visible = this.colliderShown && (urlParams.debug || this.colliderForce);
    this.model.add(this.colliderGizmo); // Add as child of model so it moves with it
    logger.debug('COLLIDER GIZMO ADDED to model', { children: this.scene.children.length });
  }

  // Per-node load prep: mesh shadows/frustum fix + flash material capture,
  // then rig-bone capture (aim chain, hand grip, foot-snap helpers).
  private prepareChild(child: THREE.Object3D): void {
    if (child instanceof THREE.Mesh) {this.prepareMesh(child);}
    if ((child as THREE.Bone).isBone) {this.captureBone(child);}
  }

  private skinnedMeshes: THREE.SkinnedMesh[] = [];
  private lodGeos: THREE.BufferGeometry[] | null = null;
  private lodLoadP: Promise<void> | null = null;
  private lod = 0;

  /** Requested capsule — stashed because the gizmo only exists after the
   *  async load(); applied at creation and on re-request. */
  private colliderCap: { height: number; half: number; radius: number } | null = null;
  /** setScale() multiplier on top of the rig fit — the collider gizmo
   *  divides by this too so the debug wire stays at the sim capsule. */
  private _visScale = 1;
  /** Re-size the debug gizmo to the class hit capsule — the gizmo was
   *  built from the generic constants and never matched light/heavy sim
   *  capsules. */
  setColliderCapsule(cap: { height: number; half: number; radius: number }): void {
    this.colliderCap = cap;
    if (!this.colliderGizmo) {return;}
    this.colliderGizmo.geometry.dispose();
    const vs = this.modelScale * this._visScale;
    this.colliderGizmo.geometry = new THREE.CapsuleGeometry(cap.radius / vs, (2 * cap.half) / vs, 4, 16);
    this.colliderGizmo.position.y = (cap.height / 2) / vs - this.feetOffsetY;
  }

  /** Distant remotes shouldn't pay the skinned shadow-pass vertex cost —
   *  nobody reads a 200m figure's cast shadow. */
  setCastShadow(on: boolean): void {
    for (const m of this.skinnedMeshes) {m.castShadow = on;}
  }

  // Offscreen remotes skip the mixer entirely, so their bones are static —
  // freezing matrixAutoUpdate drops the whole rig out of updateMatrixWorld
  // (the rig is ~40 of the ~700 bone nodes walked per frame).
  private bones: THREE.Bone[] = [];

  setBonesFrozen(frozen: boolean): void {
    for (const b of this.bones) {
      b.matrixAutoUpdate = !frozen;
      if (frozen) {b.updateMatrix();}
    }
  }

  /** Progressive bone LOD: distal bones are every bone NOT on an ancestor
   *  chain of a key bone (aim chain, grip, steady dampers, IK feet). Their
   *  subtrees — fingers, toes, rig end-markers, twist helpers — carry the
   *  ~60% of the traversal nobody can read past ~60m, so freezing them
   *  (matrixAutoUpdate off) cuts that work while the core pose still
   *  animates. Engine rule applied: never freeze a bone an essential
   *  bone hangs under — ancestors of key bones stay live by construction. */
  private distalBones: THREE.Bone[] = [];
  private distalFrozen = false;
  private distalNameSet = new Set<string>();
  private farActions = new Map<THREE.AnimationAction, THREE.AnimationAction>();

  /** Clip variant with every distal-bone track removed — the mixer
   *  skips evaluation entirely rather than writing values nobody reads.
   *  Frozen bones hold their pose; core tracks stay bit-identical. */
  private farAction(action: THREE.AnimationAction): THREE.AnimationAction {
    let a = this.farActions.get(action);
    if (!a) {
      const src = action.getClip();
      const tracks = src.tracks.filter(t =>
        !this.distalNameSet.has(normBone(t.name.slice(0, t.name.indexOf('.')))));
      a = this.mixer!.clipAction(new THREE.AnimationClip(`${src.name  }.far`, src.duration, tracks));
      this.farActions.set(action, a);
    }
    return a;
  }

  // Primary-motion bones are never expendable — the ancestor-of-keys rule
  // alone lets whole legs/arms lock mid-stride on rigs with no hand/foot
  // key bones (polyart froze at bind pose → T-posed statue at distance).
  private static readonly LIMB_BONES =
    /thigh|shin|calf|foot|leg|upperarm|forearm|collar|shoulder|clavicle|pelvis|hips|spine|ribcage|chest|neck|head|hand|palm|arm|toetip/;
  private static readonly HELPER_BONES =
    /fing|digit|thumb|lash|brow|eye|jaw|tongue|twist|roll|_end|end$|marker|prop|magazine|trigger|pad|blade|belt|extra|proxy|pole|ik/;

  private computeDistalBones(): void {
    const essential = new Set<THREE.Object3D>();
    const keys: (THREE.Object3D | undefined)[] = [
      this.handBone ?? undefined,
      ...this.pose.keyBones(),
    ];
    for (const k of keys) {
      for (let o = k; o && o !== this.model; o = o.parent!) {essential.add(o);}
    }
    this.distalBones = this.bones.filter(b => {
      if (essential.has(b)) {return false;}
      const nb = normBone(b.name);
      return PlayerModel.HELPER_BONES.test(nb) || !PlayerModel.LIMB_BONES.test(nb);
    });
    this.distalNameSet = new Set(this.distalBones.map(b => normBone(b.name)));
    // Model may finish loading while a far LOD is already armed.
    if (this.distalFrozen) {this.setDistalFrozen(true);}
  }

  setDistalFrozen(frozen: boolean): void {
    const was = this.distalFrozen;
    this.distalFrozen = frozen;
    for (const b of this.distalBones) {
      b.matrixAutoUpdate = !frozen;
      if (frozen) {b.updateMatrix();}
    }
    // Swap the running action onto the track-filtered (or full) variant —
    // same phase so the core pose doesn't pop; distal bones simply hold
    // (frozen) or resume (unfrozen) where the pose was.
    if (was !== frozen && this.currentAction && this.currentClipName) {
      const t = this.currentAction.time;
      const cur = this.currentAction;
      const next = frozen ? this.farAction(cur) : this.baseAction(cur);
      cur.stop();
      next.reset();
      next.time = t % next.getClip().duration;
      next.timeScale = cur.timeScale;
      next.setLoop(cur.loop, cur.repetitions);
      next.clampWhenFinished = cur.clampWhenFinished;
      next.setEffectiveWeight(cur.getEffectiveWeight() || 1);
      next.play();
      this.currentAction = next;
    }
  }

  private baseAction(a: THREE.AnimationAction): THREE.AnimationAction {
    for (const [base, far] of this.farActions) {if (far === a) return base;}
    return a;
  }

  /** Far-LOD swap: mannequin_lod1.glb is the same rig decimated ~80% —
   *  geometry carries the skin weights, so swapping geo alone keeps the
   *  pose. The skeleton/mixer is untouched. Only exists for 'mannequin'. */
  setLod(level: 0 | 1): void {
    // The decimated rig is mannequin-only — LOD-swapping it onto a class
    // body would graft mannequin geometry onto a foreign skeleton.
    if (this.variant !== 'mannequin') {return;}
    if (level === this.lod) {return;}
    this.lod = level;
    if (level === 0 || !this.lodGeos) { this.applyLodGeos(); return; }
    if (!this.lodLoadP) {
      this.lodLoadP = mkGltfLoader().loadAsync(RIG_MANIFEST[this.variant].lodUrl!).then((g) => {
        const geos: THREE.BufferGeometry[] = [];
        g.scene.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) {geos.push(smoothShade((o as THREE.SkinnedMesh).geometry));}
        });
        this.lodGeos = geos;
        if (this.lod === 1) {this.applyLodGeos();}
      }).catch(() => { this.lodLoadP = null; });
    }
  }

  private applyLodGeos(): void {
    if (this.lod === 1 && !this.lodGeos) {return;}
    const toLod = this.lod === 1;
    this.skinnedMeshes.forEach((m, i) => {
      if (toLod) {
        if (!m.userData.baseGeo) {m.userData.baseGeo = m.geometry;}
        const g = this.lodGeos![i];
        if (g) {m.geometry = g;}
      } else if (m.userData.baseGeo) {
        m.geometry = m.userData.baseGeo as THREE.BufferGeometry;
      }
      m.computeBoundingSphere();
      if (m.boundingSphere) {m.boundingSphere.radius += 0.6;}
    });
  }

  // Cloned rigs share material refs with every sibling clone — a damage
  // flash mutating emissive on a shared material would light up the whole
  // fleet. Clone each material once per model; the map preserves the
  // GLB's own mesh->mat sharing inside this instance.
  private matClones = new Map<THREE.Material, THREE.Material>();
  private ownMaterial(m: THREE.Material): THREE.Material {
    let c = this.matClones.get(m);
    if (!c) { c = m.clone(); this.matClones.set(m, c); }
    return c;
  }

  private prepareMesh(child: THREE.Mesh): void {
      child.castShadow = true;
      child.receiveShadow = true;
      child.geometry = smoothShade(child.geometry);
      if (this.variant === 'mannequin') {
        // The orange/purple stock figure reads as a debug doll on a
        // battlefield — re-skin: torso in the gun-prop recipe, joints in
        // the shared pickup gunmetal.
        const swap = (m: THREE.Material): THREE.Material => {
          if (m.name === 'M_Main') {return this.mannRev ? mannGunMat() : mannJointMat();}
          if (m.name === 'M_Joints') {return this.mannRev ? mannJointMat() : mannGunMat();}
          return m;
        };
        child.material = Array.isArray(child.material) ? child.material.map(swap) : swap(child.material);
      }
      child.material = Array.isArray(child.material)
        ? child.material.map((m) => this.ownMaterial(m))
        : this.ownMaterial(child.material);
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
    this.bones.push(child as THREE.Bone);
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
  // One merged geometry + shared material per remote: two meshes each
  // used to cost a draw call apiece (~17 remotes = ~34 draws).
  private static _gunGeo: THREE.BufferGeometry | null = null;
  private static _gunMat: THREE.MeshStandardMaterial | null = null;
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
    if (!PlayerModel._gunMat) {
      PlayerModel._gunMat = new THREE.MeshStandardMaterial({ color: 0x2a_2e_33, roughness: 0.55, metalness: 0.6, emissive: 0x33_44_55, emissiveIntensity: 0.8 });
    }
    if (!PlayerModel._gunGeo) {
      const body = new THREE.BoxGeometry(0.16, 0.26, 0.9);
      body.translate(0, 0, 0.25);
      const barrel = new THREE.CylinderGeometry(0.05, 0.05, 0.55);
      barrel.rotateX(Math.PI / 2);
      barrel.translate(0, 0.05, 0.75);
      PlayerModel._gunGeo = mergeGeometries([body, barrel], false)!;
      body.dispose(); barrel.dispose();
    }
    this.gun = new THREE.Group();
    this.gunMesh = new THREE.Mesh(PlayerModel._gunGeo, PlayerModel._gunMat);
    this.gun.add(this.gunMesh);
    // Measure bone world scale AFTER model.scale so the gun lands
    // real-world size (bones carry the armature's ~100x scale)
    this.model!.updateMatrixWorld(true);
    if (!handBone && classGun) {
      // Socket fallback: class bodies keep bones in armature frames up to
      // ~100 units off the rendered mesh (cyber's hips bind at -98Z), so
      // rigs that never captured a hand bone park the gun on the model
      // root at the per-variant socket instead.
      const ws = this.modelScale;
      this.gun.scale.setScalar(0.7 / ws);
      this.gunUnit = 1 / ws;
      this.gunKickZ = 0.15 * this.gunUnit;
      // gunLocal is meters above the logical feet; the model root sits
      // feetOffsetY below them on rigs not authored feet-at-origin. The
      // FX update rewrites gun.position from these base fields each
      // frame, so the socket lives in the bases, not a one-time set.
      this.gunRestX = classGun[0] * this.gunUnit;
      this.gunBaseY = (classGun[1] - this.feetOffsetY) * this.gunUnit;
      this.gunBaseZ = classGun[2] * this.gunUnit;
      this.gun.position.set(this.gunRestX, this.gunBaseY, this.gunBaseZ);
      this.gun.rotation.y = Math.PI; // barrel -Z = the body's facing
      this.muzzleFlash = ModelFx.buildMuzzleFlash();
      this.gun.add(this.muzzleFlash);
      this.model!.add(this.gun);
      this.socketGun = true;
      if (this.heldWeapon >= 0) {this.setWeapon(this.heldWeapon);}
      return;
    }
    const ws = handBone!.getWorldScale(new THREE.Vector3());
    const mount = RIG_MANIFEST[this.variant]?.mount;
    logger.debug(`GUN ATTACH`, { hand: handBone!.name, worldScale: ws.x, aimBones: this.pose.aimBoneCount });
    if (mount?.palms && this.handBoneL && this.model) {
      // Palm-line mount: model-root prop driven per frame — position at
      // the grip palm, +Z along grip→foregrip. No authored quat: the
      // palm line IS the barrel axis the clip intends, so it survives
      // every clip's differing hand basis.
      this.palmsMount = true;
      this.gunPalmFwd = mount.palmFwd ?? 0;
      this.gunPalmFlip = Boolean(mount.palmsFlip);
      this.gunPalmYaw = mount.palmYaw ?? 0;
      this.gunPalmUp = mount.palmUp ?? 0;
      this.gunMountPos = mount.pos ?? [0, 0, 0];
      this.mountGunOnModel(handBone, mount);
      return;
    }
    if (mount?.world && this.model) {
      // World-frame mount: the prop parents to the model root and tracks
      // the bone's world transform in update() — rigs with rotated
      // non-uniform armature scale shear a bone-parented prop into a
      // needle, which no per-axis scale compensation can undo.
      this.gunMountPos = mount.pos ?? [0, 0, 0];
      this.gunMountQuat = mount.quat ? new THREE.Quaternion(mount.quat[0], mount.quat[1], mount.quat[2], mount.quat[3]) : new THREE.Quaternion();
      this.mountGunOnModel(handBone, mount);
      return;
    }
    // Per-axis: some rigs (polyart) carry non-uniform bone scale that
    // squeezes the prop into a needle when only ws.x is compensated.
    const gunSize = mount?.size ?? 0.7;
    this.gunSize = gunSize;
    this.gun.scale.set(gunSize / ws.x, gunSize / ws.y, gunSize / ws.z);
    if (mount?.fat) {this.gunMesh!.scale.set(mount.fat, mount.fat, 1);}
    this.gunBaseZ = 0.05 / ws.x;
    this.gunKickZ = 0.15 / ws.x; // recoil distance in bone units
    this.gunUnit = 1 / ws.x;
    this.gunBaseY = 0.05 * this.gunUnit;
    if (mount?.pos) {
      this.gunRestX = mount.pos[0];
      this.gunBaseY = mount.pos[1];
      this.gunBaseZ = mount.pos[2];
    }
    this.gun.position.set(this.gunRestX, this.gunBaseY, this.gunBaseZ);
    // Orientation comes from the manifest: euler rigs (mannequin) roll
    // recoil through gunBaseX; quat rigs write gunBaseQuat so fx
    // envelopes compose on top instead of stomping rotation.x/z.
    // Palm axes differ per rig family — quats were solved per rig on the
    // posedump loop, tune via debugSetGunRot.
    if (mount?.euler) {
      this.gun.rotation.set(mount.euler[0], mount.euler[1], mount.euler[2]);
      this.gunBaseX = mount.euler[0];
    } else if (mount?.quat) {
      this.gunBaseQuat = new THREE.Quaternion(mount.quat[0], mount.quat[1], mount.quat[2], mount.quat[3]);
      this.gun.quaternion.copy(this.gunBaseQuat);
    } else {
      this.gun.rotation.y = Math.PI;
    }

    // Muzzle flash: additive sprite at the barrel tip, flashed on
    // fire() and faded in update(). Cheap (one sprite per remote),
    // blooms nicely at distance — this is what makes remote fire
    // readable when tracking small targets in the sky.
    this.muzzleFlash = ModelFx.buildMuzzleFlash();
    this.gun.add(this.muzzleFlash);

    handBone!.add(this.gun);
    if (this.heldWeapon >= 0) {this.setWeapon(this.heldWeapon);}
  }

  // Model-root mount tail shared by the palms/world branches — the prop
  // lives under the model, not the hand bone, so uniform modelScale is
  // the only scale compensation needed.
  private mountGunOnModel(bone: THREE.Bone | null, mount: { size?: number }): void {
    this.gunMountBone = bone;
    this.gunSize = mount.size ?? 0.7;
    this.gunUnit = 1 / this.modelScale;
    this.gunKickZ = 0.15 * this.gunUnit;
    this.gunBaseQuat = new THREE.Quaternion();
    this.gun!.scale.setScalar(this.gunSize / this.modelScale);
    this.muzzleFlash = ModelFx.buildMuzzleFlash();
    this.gun!.add(this.muzzleFlash);
    this.model!.add(this.gun!);
    if (this.heldWeapon >= 0) {this.setWeapon(this.heldWeapon);}
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

  // Mannequin/knight clips need their hip XZ root motion stripped — the
  // entity owns world position, and loop clips otherwise translate the
  // mesh out from under the hitbox each cycle. Y stays (the crouch dip).
  private registerClip(clip: THREE.AnimationClip, mann: boolean, knight: boolean): void {
    if (mann || knight || CLASS_BODY_SPEC[this.variant]) {
      stripHipXZ(clip, this.rootMotionNodes());
      clampHipY(clip, 0.25, this.rootMotionNodes());
      if (mann && isLayeredClip(clip.name)) {
        clip.tracks = clip.tracks.filter(t => {
          const bn = normBone(t.name.slice(0, t.name.indexOf('.')));
          // Arm tracks always yield; torso quat tracks too (aim layer
          // owns them now) — position tracks stay for the stride bob.
          if (AIM_BONE_MASK.has(bn)) {return false;}
          if (t.name.endsWith('.quaternion') && AIM_TORSO_BONES.has(bn)) {return false;}
          return true;
        });
        dampenSway(clip, SWAY_BONES);
      }
    }
    const action = this.mixer!.clipAction(clip);
    this.animations.set(clip.name, action);
    if (mann) {this.animations.set('UAL_' + clip.name, action);}
  }

  /** Authored clips can bake a facing turn into the hip track — the
   *  polyart pack's Idle_Ducking_ar carries the body at +95° vs the
   *  ~-138° every other clip agrees on, so skiing flipped him toward
   *  the camera. Measure each clip's first key on the animated hip
   *  node, take the set's modal yaw as the rig's forward convention,
   *  and unwind outliers (>~30°) back onto it in the node's parent
   *  frame. */
  private alignHipYaw(): void {
    if (!this.model) {return;}
    const fwd = new THREE.Vector3();
    const q = new THREE.Quaternion();
    // Track names may carry loader dedup suffixes (Hips_1) and rigs can
    // contain more than one 'Hips' node, so resolve each quaternion
    // track's target and keep the shallowest real bone — the node the
    // clips actually rotate.
    const hipTrackOf = (clip: THREE.AnimationClip): { tr: THREE.KeyframeTrack; node: THREE.Object3D } | null => {
      let best: { tr: THREE.KeyframeTrack; node: THREE.Object3D } | null = null;
      let any: { tr: THREE.KeyframeTrack; node: THREE.Object3D } | null = null;
      for (const tr of clip.tracks) {
        if (!tr.name.endsWith('.quaternion')) {continue;}
        const node = this.model!.getObjectByName(tr.name.slice(0, -'.quaternion'.length));
        if (!node) {continue;}
        if ((node as THREE.Bone).isBone && (!best || this.depthOf(node) < this.depthOf(best.node))) {best = { tr, node };}
        if (!any || this.depthOf(node) < this.depthOf(any.node)) {any = { tr, node };}
      }
      return best ?? any;
    };
    const yawOf = (tr: THREE.KeyframeTrack): number => {
      const v = tr.values;
      q.set(v[0], v[1], v[2], v[3]);
      fwd.set(0, 0, 1).applyQuaternion(q);
      return Math.atan2(fwd.x, fwd.z);
    };
    const canonical = (() => {
      // A rig's own authored clips set the convention — a retarget pack
      // can outnumber them (29 baked vs 16 native on class_heavy) and
      // swing the vote to the bake's frame, rotating the native set.
      // When natives exist they alone define canonical; pure-bake rigs
      // fall through to the all-clip vote (and carry clipYawFix anyway).
      const collect = (names: (n: string) => boolean) => {
        const buckets = new Map<number, { sum: number; n: number }>();
        for (const [name, a] of this.animations) {
          if (!names(name)) {continue;}
          const hit = hipTrackOf(a.getClip());
          if (!hit) {continue;}
          const y = yawOf(hit.tr);
          const k = Math.round(y / (Math.PI / 18));
          const b = buckets.get(k) ?? { sum: 0, n: 0 };
          b.sum += y; b.n++;
          buckets.set(k, b);
        }
        let best = { sum: 0, n: 0 };
        for (const b of buckets.values()) {if (b.n > best.n) best = b;}
        return best.n ? best.sum / best.n : null;
      };
      const natives = collect(n => !n.startsWith('UAL_'));
      return natives ?? collect(() => true);
    })();
    if (canonical === null) {return;}
    // clipYawFix is an explicit unwind: rigs whose whole retarget set
    // shares the wrong convention (100%-bake rigs) can't derive a target
    // from local-track yaw — the armature parent carries its own offset —
    // so every hip track just gets premultiplied by the fix, no measure.
    const fixRad = RIG_MANIFEST[this.variant]?.clipYawFix ?? 0;
    this.model.updateMatrixWorld(true);
    const fixed: string[] = [];
    for (const [, a] of this.animations) {
      const clip = a.getClip();
      const hit = hipTrackOf(clip);
      if (!hit?.node.parent) {continue;}
      let delta = fixRad === 0 ? yawOf(hit.tr) - canonical : -fixRad;
      while (delta > Math.PI) {delta -= 2 * Math.PI;}
      while (delta < -Math.PI) {delta += 2 * Math.PI;}
      if (Math.abs(delta) < 0.5) {continue;}
      // Every hip-skeleton copy carries the same yaw — retarget fan-out
      // ships one track per skin joint, so the fix lands on all of them
      // or the meshes rotate away from each other.
      const hipBase = hit.node.name.replace(/_\d+$/, '');
      for (const tr of clip.tracks) {
        if (!tr.name.endsWith('.quaternion')) {continue;}
        const node = this.model.getObjectByName(tr.name.slice(0, -'.quaternion'.length));
        if (!node?.parent || node.name.replace(/_\d+$/, '') !== hipBase) {continue;}
        const parentQ = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().copy(this.model.matrixWorld).invert().multiply(node.parent.matrixWorld));
        const fix = parentQ.clone().invert()
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -delta))
          .multiply(parentQ);
        const v = tr.values;
        for (let i = 0; i < v.length; i += 4) {
          q.set(v[i], v[i + 1], v[i + 2], v[i + 3]).premultiply(fix);
          v[i] = q.x; v[i + 1] = q.y; v[i + 2] = q.z; v[i + 3] = q.w;
        }
      }
      fixed.push(clip.name);
    }
    if (fixed.length > 0) {logger.debug(`Hip-yaw outliers corrected: ${fixed.join(', ')}`);}
  }

  private depthOf(node: THREE.Object3D): number {
    let d = 0;
    for (let p = node.parent; p && p !== this.model; p = p.parent) {d++;}
    return d;
  }

  playAnimation(name: string, startPhase = 0): void {
    if (!this._loaded) { this._queuedAnim = name; return; }
    const base = this.animations.get(name);
    if (!base) {
      // An EMPTY table is the pre-bake window — zero-native-clip variants
      // (cybersoldier) resolve every state to a miss until the retarget
      // lands; warning there is noise. A miss inside a populated set is
      // the real defect the warn exists for.
      if (this.animations.size > 0) {
        const missKey = `${this.variant}:${name}`;
        if (!this._warnedAnims.has(missKey)) {
          this._warnedAnims.add(missKey);
          logger.warn(`Animation not found: ${name} (variant ${this.variant})`);
        }
      }
      // Zero-native-clip variants (cybersoldier) resolve every state to a
      // missing fallback until the async retarget bake lands — returning
      // with no action running holds the model at bind pose for the whole
      // window. Any real clip beats bind pose, so park on the idle loop
      // (or the first available clip) while the requested one is absent.
      if (!this.currentAction?.isRunning()) {
        const hold = this.animations.has('UAL_Idle_Loop') ? 'UAL_Idle_Loop' : this.animations.keys().next().value;
        if (hold) {return this.playAnimation(hold);}
      }
      return;
    }
    const action = this.distalFrozen ? this.farAction(base) : base;
    // Same clip re-requested (jump↔jet share clips on the class rigs) —
    // refading an already-running action dips its weight through 0 and
    // flashes the bind pose; oneshots still restart since a replay is
    // the point of re-firing them.
    if (action === this.currentAction && !ONESHOT_CLIPS.has(name) && startPhase <= 0) {
      this.currentClipName = name;
      this.playingUAL = name.startsWith('UAL_');
      return;
    }

    // (no per-clip head bookkeeping — the pitch un-apply in update() handles
    // both tracked and untracked head bones, including the case where the
    // mixer skips writing because the track value didn't change)

    const prev = this.currentAction;
    if (prev && prev !== action) {this.fadeAction(prev, 0, 0.2);}

    action.reset();
    // Pistol_Shoot's first ~180ms is a draw wind-up — an arm sweeps wide
    // before settling on target. Replayed every shot it reads as the
    // model spreading its arms each trigger pull. Skip to the aimed
    // frame and crossfade fast so the snap reads as recoil, not a draw.
    const isShoot = name === 'Pistol_Shoot' || name === 'UAL_Pistol_Shoot';
    if (isShoot) {action.time = 0.18;}
    // Direction flip mid-stride: enter the new clip at the previous clip's
    // cycle phase so the footfall doesn't restart mid-step.
    else if (startPhase > 0) {action.time = startPhase * action.getClip().duration;}
    // From live weight → 1: same-action refire also ramps (a cancelled
    // fade can park it mid-weight), so coverage never touches 0.
    this.fadeAction(action, 1, isShoot ? 0.06 : 0.2);
    action.timeScale = 1;
    // Death: play once, clamp the corpse.
    // Jump: Tribes-style fall cycle — ping-pong at ~1/3 speed. LoopRepeat
    // restarts the clip every cycle (bunny-hop midair); a frozen clamp
    // reads as a statue. The slow reversed tuck↔extend cycle reads as
    // flailing/swimming through air and needs no separate fall anim.
    if (name === 'Death' || name === 'UAL_Death01' || CLASS_BODY_DEATH_CLIPS.has(name)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else if (ONESHOT_CLIPS.has(name)) {
      action.setLoop(THREE.LoopOnce, 1);
      // A finished unclamped action gets deactivated by the mixer, and a
      // deactivated binding restores the bone's ORIGINAL transform — the
      // literal bind-pose flash when the sole covering action ends before
      // the next state takes over. Clamp every oneshot's tail; the state
      // machine time-reverts these anyway, so the freeze is invisible.
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
    this.currentClipName = name;
    this.playingUAL = name.startsWith('UAL_');
  }

  /** Facing-frame velocity → 8-way dir; when the KevDev directional clips
   *  baked, walk/run re-resolves onto the matching stride (phase carried
   *  over so the footfall doesn't pop). Returns true while a dedicated
   *  clip drives the motion — callers drop the reverse/lean fallbacks. */
  setLocomotionVector(fwd: number, side: number): boolean {
    const dir = DIR8[((Math.round(Math.atan2(side, fwd) / (Math.PI / 4)) % 8) + 8) % 8];
    if (dir !== this.locoDir) {
      this.locoDir = dir;
      if (this.currentState === 'walk' || this.currentState === 'run')
        {this.forceAnimationState(this.currentState, true);}
    }
    return this.dirClipActive;
  }

  // Locomotion direction: sectors without a dedicated clip run the
  // walk/run clip in reverse (the UE "Rate Scale -1" blendspace trick —
  // the footstep phase flips too, which is what kills the moonwalk look).
  setLocomotionReversed(rev: boolean): void {
    const a = this.currentAction;
    if (!a) {return;}
    const sign = rev ? -1 : 1;
    if (Math.sign(a.timeScale || 1) === sign) {return;}
    const dur = a.getClip().duration;
    a.time = dur - a.time; // preserve the cycle phase across the flip
    a.timeScale = Math.abs(a.timeScale || 1) * sign;
  }

  get animationState(): AnimationState {
    return this.currentState;
  }

  setAnimationState(state: AnimationState): void {
    if (this.currentState === state) {return;}
    this.forceAnimationState(state);
  }

  // Force animation switch without checking current state (for hysteresis).
  // keepPhase carries the outgoing clip's cycle position into the new one —
  // used when a locomotion direction flip re-resolves walk/run mid-stride.
  forceAnimationState(state: AnimationState, keepPhase = false): void {
    const prev = this.currentAction;
    const phase = keepPhase && prev ? prev.time / Math.max(prev.getClip().duration, 1e-6) : 0;
    this.currentState = state;
    this.dirClipActive = false;
    // The whole cascade lives in clipCandidates — knight/class tables,
    // directional strides, per-variant overrides, UAL→native fallback,
    // in that order. The last candidate is always a table-native name
    // played unconditionally (missing clip = hold pose, not snap).
    const cands = clipCandidates(this.variant, state, this.locoDir);
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const last = i === cands.length - 1;
      if (!last && !this.animations.has(c.name)) {continue;}
      this.dirClipActive = c.dir;
      this.playAnimation(c.name, c.dir ? phase : 0);
      return;
    }
    // Empty table (class-body anims gap) — hold the previous action.
  }

  /**
   * Bake the Quaternius UAL clips onto the robot skeleton — once per
   * process. The first loaded model pays the resample; every later
   * instance reuses the name-keyed clip data (all robots share the same
   * rest pose, so the results are identical).
   */
  private retargetUAL(): void {
    if (!this.model) {return;}
    const {model} = this;
    const adopt = (baked: Map<string, THREE.AnimationClip>) => {
      if (this._disposed || !this.mixer || !this.model) {return;}
      // Baked clips arrive fully cooked — hip-XZ strip and the
      // mannequin aim-layer carve are applied at bake time.
      // `__holdbake1` marks packs whose arm tracks already carry the
      // hip-fire grip — the runtime holdBones compose stands down.
      this.pose.holdBaked = baked.has('__holdbake1');
      for (const [name, clip] of baked) {
        if (name === '__holdbake1') {continue;}
        this.animations.set(name, this.mixer.clipAction(clip));
      }
      // Baked clips land AFTER the load-time alignHipYaw ran — for
      // retarget-only rigs that pass saw an empty table and did nothing.
      // Re-run so the bake's own hip convention gets canonicalized.
      if (CLASS_BODY_SPEC[this.variant]) {this.alignHipYaw();}
      // Aim clips ride inside the retarget pack for rigs like robot —
      // the load-time aim-layer build saw an empty table for them.
      // Robot's aim clips carry pitch in the spine tracks, so his mask
      // includes the torso chain (arm-only sweeps horizontally).
      if ([...baked.keys()].some(n => n.includes('Aim_')))
        {this.pose.buildAimLayer(this.mixer, this.animations, this.variant === 'robot');}
      // Re-resolve the current state onto the better clip if one landed —
      // the baked names now sit in the same candidate table the state
      // resolver reads, so let it pick (a bare 'Idle' name doesn't exist
      // on every rig).
      this.forceAnimationState(this.currentState);
    };
    const runtimeBake = () =>
      bakeUALClips(model, this.variant).then(adopt)
        .catch((error) => { logger.warn('UAL bake failed for ' + this.variant, error); });
    // The offline bake (public/assets/anims/<variant>.glb) ships the
    // whole retarget so load never flashes bind pose or burns a
    // resample; missing file → dev rigs still runtime-bake.
    loadBakedUALClips(this.variant).then(baked => {
      if (baked && baked.size > 0) {adopt(baked);}
      else {runtimeBake();}
    }).catch(runtimeBake);
  }

  update(dt: number): void {
    // Step manual weight fades: ramp effective weight from whatever it
    // was when scheduled, never a hardcoded 0/1 endpoint. Zero-weight
    // fades end by stopping the action so its bindings free up.
    for (const [a, f] of this.fades) {
      if (!a.enabled && f.to > 0) {this.fades.delete(a); continue;}
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      a.setEffectiveWeight(f.from + (f.to - f.from) * k);
      if (k >= 1) {
        this.fades.delete(a);
        if (f.to === 0) {a.stop();}
      }
    }
    // Stalled-cover guard: a disabled sole action restores bind pose the
    // next mixer tick. If the current action ever stops running outside
    // death, re-enter the state rather than let the body T-pose. A
    // finished oneshot parked on clampWhenFinished reads paused — its
    // tail pose IS the cover, not a stall; re-entering replays the
    // clip forever (perf run: 'shoot' state looping every clip-length).
    if (this.currentAction && !this.currentAction.isRunning() && !this.currentAction.paused && this.currentState !== 'death') {
      if (!this._warnedAnims.has('__stall')) {
        this._warnedAnims.add('__stall');
        logger.warn(`Anim action stalled in state '${this.currentState}' (${this.currentClipName}) — re-entering`);
      }
      this.forceAnimationState(this.currentState);
    }
    this.pose.update(dt, this.mixer, this.currentAction, this.currentClipName, this.playingUAL, this.model ?? undefined, this.currentState);
    if (this.gunMountBone && this.gun && this.model) {
      // Refresh the fx base fields from the bone's live world transform —
      // tickGunFx composes kick/swap/throw deltas on top of these.
      const mb = this.gunMountBone;
      mb.updateWorldMatrix(true, false);
      mb.localToWorld(_gunV.set(this.gunMountPos[0], this.gunMountPos[1], this.gunMountPos[2]));
      this.model.worldToLocal(_gunV);
      this.gunRestX = _gunV.x; this.gunBaseY = _gunV.y; this.gunBaseZ = _gunV.z;
      if (this.palmsMount && this.handBoneL) {
        // Palm-line mount: the barrel axis is right-palm → left-palm.
        // Degenerate (hands split for a one-hand clip) → keep the palm
        // seat but aim model-forward (-Z) instead of a garbage line.
        this.handBoneL.getWorldPosition(_gunPalmL);
        this.model.worldToLocal(_gunPalmL);
        _gunDir.subVectors(_gunPalmL, _gunV);
        const len = _gunDir.length();
        if (len > 0.03) {_gunDir.divideScalar(len);} else {_gunDir.set(0, 0, -1);}
        // |z| guard: hand-splits (one-hand clips) give lateral axes —
        // fall back to model forward. Either z sign is valid: rigs grip
        // both handednesses (polyart's palm line runs +Z).
        if (Math.abs(_gunDir.z) < 0.15) {_gunDir.set(0, 0, -1);}
        if (this.gunPalmFlip) {_gunDir.negate();}
        // Seat offset along the barrel — right-palm seat alone reads too
        // far back on two-hand holds (polyart's marine grip).
        if (this.gunPalmFwd || this.gunPalmUp) {
          _gunV.addScaledVector(_gunDir, this.gunPalmFwd);
          _gunV.y += this.gunPalmUp;
          this.gunRestX = _gunV.x; this.gunBaseY = _gunV.y; this.gunBaseZ = _gunV.z;
        }
        // lookAt maps -Z to eye→target; eye=left palm, target=right →
        // +Z = grip→foregrip = barrel dir. Slerp so clip jitter and
        // state pops don't buzz the muzzle.
        if (this.gunPalmFlip) {_gunLook.lookAt(_gunV, _gunPalmL, _gunUp);}
        else {_gunLook.lookAt(_gunPalmL, _gunV, _gunUp);}
        _gunQ2.setFromRotationMatrix(_gunLook);
        if (this.gunPalmYaw) {_gunQ2.premultiply(_gunQYaw.setFromAxisAngle(_gunUp, this.gunPalmYaw));}
        this.gunBaseQuat!.slerp(_gunQ2, Math.min(dt * 14, 1));
      } else {
        mb.getWorldQuaternion(_gunQ);
        this.model.getWorldQuaternion(_gunMQ).invert();
        this.gunBaseQuat!.copy(_gunMQ).multiply(_gunQ).multiply(this.gunMountQuat!);
      }
      this.gun.scale.setScalar(this.gunSize / this.modelScale);
    }
    this.fx.tick(dt);
  }

  /** Barrel-tip world point — third-person beam/tracer anchor. */
  muzzleWorld(out: THREE.Vector3): boolean {
    if (!this.muzzleFlash) {return false;}
    this.muzzleFlash.getWorldPosition(out);
    return true;
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
    // Weapon switches fire before the GLB loads (spawn loadout races the
    // async mesh) — stash the pick on heldWeapon so attachGun's tail can
    // re-apply it the moment a gun mount exists instead of dropping it.
    this.heldWeapon = wt;
    if (!this.gunMesh) {return;}
    const hit = handWeaponGeo(wt);
    const geo = hit?.geo ?? PlayerModel._gunGeo!;
    if (this.gunMesh.geometry !== geo) {
      this.gunMesh.geometry = geo;
      // Baked models carry their own per-part materials; the generic prop
      // keeps its shared grey.
      this.gunMesh.material = hit ? hit.mats : PlayerModel._gunMat!;
      if (this.wireframeOn) {this.captureWireframeMats();}
      // Flash rides the baked model's real muzzle, not a fixed offset —
      // each baked geo already carries its bounding box from the baker.
      if (this.muzzleFlash && geo.boundingBox) {
        this.muzzleFlash.position.set(0, 0.05, geo.boundingBox.max.z + 0.08);
      }
    }
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

  // Ghost shimmer — translucent material override for the decloak-reveal.
  // Baselines are captured once so restore hands every material its own
  // state back (GLBs share materials across meshes).
  private ghostBaseline: Map<THREE.Material, { transparent: boolean; opacity: number; depthWrite: boolean }> | null = null;
  setGhost(on: boolean): void {
    if (!this.model) {return;}
    if (on) {
      if (this.ghostBaseline) {return;}
      this.ghostBaseline = new Map();
      this.model.traverse((child) => {
        const mat = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) {return;}
        for (const m of Array.isArray(mat) ? mat : [mat]) {
          this.ghostBaseline!.set(m, { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite });
          m.transparent = true;
          m.opacity = 0.28;
          m.depthWrite = false;
        }
      });
      return;
    }
    if (!this.ghostBaseline) {return;}
    for (const [m, st] of this.ghostBaseline) {
      m.transparent = st.transparent;
      m.opacity = st.opacity;
      m.depthWrite = st.depthWrite;
    }
    this.ghostBaseline = null;
  }

  /** Friend-or-foe tint on the debug hitbox — remotes recolor on team
   *  assign; untouched models stay the default friendly green. The hex is
   *  cached so a call landing before the GLB load still tints the capsule
   *  when it's built. */
  setColliderColor(hex: number): void {
    this.colliderHex = hex;
    this.colliderMat?.color.setHex(hex);
    // This runs every frame per remote — piggyback the debug-visibility
    // refresh so the menu DEBUG toggle applies without a reload.
    if (this.colliderGizmo) {this.colliderGizmo.visible = this.colliderShown && (urlParams.debug || this.colliderForce);}
  }

  private wireframeMats: THREE.Material[] | null = null;
  private wireframeOn = false;
  /** Debug (?debug / menu DEBUG): render the body as wireframe so it can be
   *  eyeballed against the collider capsule. */
  private captureWireframeMats(): void {
    if (!this.model) {return;}
    const mats = new Set<THREE.Material>();
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) {return;}
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {mats.add(m);}
    });
    this.wireframeMats = [...mats];
  }
  setWireframe(on: boolean): void {
    if (!this.model || on === this.wireframeOn) {return;}
    this.wireframeOn = on;
    if (on) {
      this.captureWireframeMats();
    }
    for (const m of this.wireframeMats || []) {(m as THREE.MeshBasicMaterial).wireframe = on;}
  }

  private colliderShown = true;
  /** `force` bypasses the ?debug gate — lab/inspect surfaces drive the
   *  gizmo directly, without flipping the global debug flag. Sticky so
   *  a gizmo created later (async load) still honors the lab toggle. */
  private colliderForce = false;
  setColliderVisible(visible: boolean, force = false): void {
    this.colliderShown = visible;
    this.colliderForce = force;
    if (this.colliderGizmo) {
      this.colliderGizmo.visible = visible && (force || urlParams.debug);
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
      this.colliderGizmo.visible = this.colliderShown && (urlParams.debug || this.colliderForce);
      logger.debug('COLLIDER GIZMO RE-ADDED to model');
    }
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
      if (this.colliderGizmo) {
        this.setColliderCapsule(this.colliderCap ?? {
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
      this.mixer?.stopAllAction();
      this.animations.clear();
      this.model = null;
      this.mixer = null;
      this.currentAction = null;
      this.gibParts = null; // just (mesh, indices) — nothing GPU-owned here
      // Per-model material clones — frees their GPU program refs; shared
      // geometry/textures belong to the cached gltf and stay alive.
      this.matClones.forEach((m) => m.dispose());
      this.matClones.clear();
    }
    if (this.colliderGizmo) {
      // Collider gizmo is a child of the model, so it's already removed when model is removed
      // Just dispose of resources
      this.colliderGizmo.geometry.dispose();
      (this.colliderGizmo.material as THREE.Material).dispose();
      this.colliderGizmo = null;
      this.colliderMat = null;
    }
  }
}
