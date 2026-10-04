import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

import { PLAYER_RADIUS, CAPSULE_CYLINDER_HEIGHT, CAPSULE_CENTER_Y } from '../core/config.js';
import { urlParams } from '../core/params.js';

import { ChildLogger } from '../core/Logger.js';
import { buildGibParts, bakeDeathParts, type GibPart } from './playerGibs.js';

const logger = new ChildLogger('PlayerModel');

const X_AXIS = new THREE.Vector3(1, 0, 0);
const _pitchQuat = new THREE.Quaternion();
const _footW = new THREE.Vector3();
const _footQ = new THREE.Quaternion();
const _footPQ = new THREE.Quaternion();
const _d2r = (x: number, y: number, z: number): [number, number, number] =>
  [x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180];

// Several body GLBs ship flat normals (per-face corners) — the robot
// reads faceted because it IS faceted. toCreasedNormals re-averages
// normals across coplanar verts: curvature goes smooth, edges past the
// 60° crease stay hard. One pass per geometry — GLBs share geo across
// meshes, so cache by source.
const _creased = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
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
  isLayeredClip, AIM_BONE_MASK, SWAY_BONES, type LocoDir } from './playerClipSurgery.js';
import { ModelFx } from './modelFx.js';
import { bakeUALClips, loadBakedUALClips } from './playerUal.js';
import { handWeaponGeo } from './handWeapons.js';
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
  // Facing-frame locomotion direction, quantized to 8 sectors — feeds the
  // KevDev directional clip table when state is 'walk'/'run'.
  private locoDir: LocoDir = 'F';
  /** True while a dedicated directional clip drives the current action —
   *  callers skip the reverse-playback/strafe-lean fallbacks then. */
  dirClipActive = false;
  private colliderGizmo: THREE.Mesh | null = null;
  private colliderMat: THREE.MeshBasicMaterial | null = null;
  private colliderHex = 0x00ff00;
  // Aim-pitch bones: quaternion pitch stacked on top of the animated pose.
  // lastPitch is un-applied before the mixer runs so it never accumulates
  // (the mixer skips bones whose track value didn't change).
  private aimBones: { bone: THREE.Object3D; factor: number; last: THREE.Quaternion }[] = [];
  private aimPitch = 0;
  // Socket-gun rigs: canned right-arm grip pose stacked post-mixer — their
  // retargeted clips flatten the arm raise (rig axis mismatch), so the arm
  // is posed procedurally to meet the fixed gun socket. Same un-apply
  // trick as aimBones so the multiply never accumulates.
  private holdBones: { bone: THREE.Object3D; role: number; off: THREE.Quaternion; last: THREE.Quaternion; bind: THREE.Quaternion }[] = [];
  // Right-arm grip pose per bone role — norm-name set + euler offset in
  // bone-local space. Tuned on the posedump screenshot loop per rig.
  private static HOLD_CHAINS: [Set<string>, [number, number, number]][] | null = null;
  private static buildHoldChains(): void {
    if (PlayerModel.HOLD_CHAINS) return;
    PlayerModel.HOLD_CHAINS = [
      [new Set(['upperarmr', 'basehumanrupperarm']), _d2r(-45, -30, -15)],
      [new Set(['lowerarmr', 'forearmr', 'basehumanrforearm1', 'basehumanrforearm']), _d2r(-50, 0, 0)],
      [new Set(['handr', 'palm2r', 'fistr', 'basehumanrpalm']), _d2r(0, 0, 0)],
      // Left arm comes across to the foregrip — without it the retargeted
      // clip tracks flail the free arm every frame.
      [new Set(['upperarml', 'basehumanlupperarm']), _d2r(-60, 25, 15)],
      [new Set(['lowerarml', 'forearml', 'basehumanlforearm1', 'basehumanlforearm']), _d2r(-70, 0, 0)],
      [new Set(['handl', 'palm2l', 'fistl', 'basehumanlpalm']), _d2r(0, 0, 0)],
    ];
  }
  // Solved hand-local mount quats (x,y,z,w) per class-body variant —
  // barrel on facing, rail up. Quats, not eulers: euler extraction was
  // lossy under these bone spaces. Mannequin keeps its own path above.
  private static GUN_MOUNT_QUAT: Record<string, [number, number, number, number]> = {
    cybersoldier: [0.1926, -0.5309, 0.2594, -0.3372],
    vexa: [0.1926, -0.5309, 0.2594, -0.3372],
    scifisoldier: [-0.471, 0.1186, 0.0367, 0.5126],
    polyart: [0.3609, -0.3991, 0.315, -0.3336],
  };
  // Bone-space mount position overrides (hand-bone local units) where the
  // generic near-origin seat buries the prop inside the wrist.
  private static GUN_MOUNT_POS: Record<string, [number, number, number]> = {
    polyart: [-5, 8, 15],
  };
  private wantHoldPose = false;
  private holdW = 0;

  /** Live-tune the hand-bone mount rotation (posedump loop) — deg euler. */
  debugSetGunRot(x: number, y: number, z: number): void {
    this.gun?.rotation.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180);
  }

  /** Live-tune the hold pose (posedump iteration loop) — deg per role. */
  debugSetHold(upper: [number, number, number], lower: [number, number, number], hand: [number, number, number], lUpper: [number, number, number] = upper.map(v => -v) as [number, number, number], lLower: [number, number, number] = lower, lHand: [number, number, number] = hand): void {
    const rads = [upper, lower, hand, lUpper, lLower, lHand].map(e =>
      new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0] * Math.PI / 180, e[1] * Math.PI / 180, e[2] * Math.PI / 180)));
    for (const hb of this.holdBones) hb.off.copy(rads[hb.role]!);
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
  // Masked aim layer (mannequin): Pistol_Aim_* clips filtered to the
  // spine/arms/head tracks, layered over whatever locomotion clip the legs
  // are running — remotes always hold the weapon up, even mid-sprint. The
  // aim clips cover ~±55° of pitch; the procedural aimBones pitch applies
  // only the residual beyond that so extreme aim still lands.
  private aimUp: THREE.AnimationAction | null = null;
  private aimNeutral: THREE.AnimationAction | null = null;
  private aimDown: THREE.AnimationAction | null = null;
  private static readonly AIM_CLIP_RAD = 0.95; // pitch where Up/Down reaches full weight
  // Hips-and-up rotation chain locked toward bind pose while the model
  // is firing — hip POSITION tracks still animate (stride bob survives,
  // and leg swing lives on the thigh bones, not hip rotation). DampenSway
  // leaves half the stride roll, which still waves the muzzle through
  // the arm chain's parent; this kills it outright while shots go out.
  private static readonly STEADY_BONES = new Set([
    'defhips', 'defspine001', 'defspine002', 'defspine003', 'defneck', 'defhead',
    'hips', 'spine', 'chest', 'neck', 'head',
    'rigass', 'rigspine1', 'rigspine2', 'rigspine3', 'rigneck', 'righead',
  ]);
  private steadyBones: { bone: THREE.Object3D; bind: THREE.Quaternion }[] = [];
  // 0→1 ramp while recently fired — drives the spine lock.
  private armedT = 0;
  private armed = 0;
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
   *  native clips, armored read at distance.
   *  'scifisoldier'/'vexa'/'polyart' = the UAS class bodies —
   *  each bakes its own clip set on its own rig (vexa ships
   *  none, it stands static until a clip'd medium replaces it). */
  readonly variant: PlayerModelVariant;

  constructor(scene: THREE.Scene, variant?: PlayerModelVariant) {
    this.scene = scene;
    this.variant = variant ?? (urlParams.get('model') === 'mannequin' ? 'mannequin' : 'robot');
    PlayerModel.buildHoldChains();
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    const mann = this.variant === 'mannequin';
    const knight = this.variant === 'knight';

    return new Promise((resolve, reject) => {
      let attempts = 0;
      const attempt = () => {
      loader.load(
        RIG_MANIFEST[this.variant]?.url ?? '/assets/models/RobotExpressive.glb',
        (gltf) => {
          if (this._disposed) { resolve(); return; }
          this.onModelLoaded(gltf, mann, knight);
          resolve();
        },
        (xhr) => {
          logger.debug(`Loading: ${(xhr.loaded / xhr.total * 100).toFixed(0)}%`);
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

    // Log model bounding box for hitbox calibration
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const min = box.min;
    const max = box.max;
    logger.debug(`Model bounding box: size=(${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)}) min=(${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}) max=(${max.x.toFixed(2)},${max.y.toFixed(2)},${max.z.toFixed(2)})`);

    // Enable shadow casting + grab aim/attachment bones
    this.model.traverse((child) => this.prepareChild(child));
    this.computeDistalBones();
    // Model may finish loading while a far-LOD swap is already armed —
    // the freshly captured skinnedMeshes need the swap applied now.
    if (this.lod === 1) this.applyLodGeos();
    logger.debug(`Aim bones: ${this.aimBones.map(b => b.bone.name).join(', ') || 'NONE'} | hand: ${this.handBone?.name ?? 'NONE'}`);

    // Scale and rotate to match our coordinate system
    // Model bounding box at scale 1.0: x: 3.2, y: 4.8, z: 3.2
    // At scale 0.5: x: 1.6, y: 2.4, z: 1.6
    // Hitbox: radius 0.8 (width 1.6), height 2.0
    // Scale factor 0.5 matches width, but model is taller (2.4 vs 2.0)
    // RobotExpressive.glb origin is at feet (y=0), not center
    const classBody = CLASS_BODY_SPEC[this.variant];
    const rig = RIG_MANIFEST[this.variant];
    const scale = rig?.fitH !== undefined ? rig.fitH / size.y : (rig?.fixedScale ?? 0.5); // class bodies fit their capsule eye height — the body IS the class silhouette
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
    if (this.handBone || classBody?.gunLocal) this.attachGun(mann);
    else logger.warn('GUN NOT ATTACHED — no hand bone or gun socket');

    // No Y offset needed — model origin is already at feet

    // Set up animation mixer
    this.mixer = new THREE.AnimationMixer(this.model);

    // Store animations with mapping. Mannequin clips ARE the UAL
    // clips natively — alias them under the UAL_ names the state map
    // prefers so ANIM_NAMES resolves without a retarget pass.
    for (const clip of gltf.animations) this.registerClip(clip, mann, knight);
    if (CLASS_BODY_SPEC[this.variant]) this.alignHipYaw();
    if (mann) this.buildAimLayer();

    logger.debug('Loaded animations:', Array.from(this.animations.keys()));

    this._loaded = true;
    // Start with whatever the last request was (remotes spawn mid-
    // load and ask for Running/Walking before the mixer exists). The
    // default goes through the state table — a bare 'Idle' name only
    // exists on knight's rig, other variants resolve their own idle.
    if (this._queuedAnim) this.playAnimation(this._queuedAnim);
    else this.forceAnimationState('idle');
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
    if ((RIG_MANIFEST[this.variant]?.sources.length ?? 0) > 0) this.retargetUAL();

    this.scene.add(this.model);
    logger.debug('MODEL ADDED to scene', { children: this.scene.children.length });

    // Create collider gizmo (wireframe capsule for hitbox visualization)
    // Uses same constants as collision detection — single source of truth in config.ts
    // CapsuleGeometry(radius, cylinderHeight, ...) — cylinderHeight excludes hemispheres
    // Model is scaled by 0.5, so divide by scale to get correct world size
    const colliderGeo = new THREE.CapsuleGeometry(PLAYER_RADIUS / this.modelScale, CAPSULE_CYLINDER_HEIGHT / this.modelScale, 4, 16);
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
    this.colliderGizmo.position.y = CAPSULE_CENTER_Y / this.modelScale - this.feetOffsetY;
    this.colliderGizmo.renderOrder = 999; // Render last (on top)
    // Hitbox visualization is a debug overlay — same flag as the
    // AOE blast wireframes (menu DEBUG toggle / ?debug).
    this.colliderGizmo.visible = urlParams.debug;
    this.model.add(this.colliderGizmo); // Add as child of model so it moves with it
    logger.debug('COLLIDER GIZMO ADDED to model', { children: this.scene.children.length });
  }

  // Per-node load prep: mesh shadows/frustum fix + flash material capture,
  // then rig-bone capture (aim chain, hand grip, foot-snap helpers).
  private prepareChild(child: THREE.Object3D): void {
    if (child instanceof THREE.Mesh) this.prepareMesh(child);
    if ((child as THREE.Bone).isBone) this.captureBone(child);
  }

  private skinnedMeshes: THREE.SkinnedMesh[] = [];
  private lodGeos: THREE.BufferGeometry[] | null = null;
  private lodLoadP: Promise<void> | null = null;
  private lod = 0;

  /** Re-size the debug gizmo to the class hit capsule — the gizmo was
   *  built from the generic constants and never matched light/heavy sim
   *  capsules. */
  setColliderCapsule(cap: { height: number; half: number; radius: number }): void {
    if (!this.colliderGizmo) return;
    this.colliderGizmo.geometry.dispose();
    this.colliderGizmo.geometry = new THREE.CapsuleGeometry(cap.radius / this.modelScale, (2 * cap.half) / this.modelScale, 4, 16);
    this.colliderGizmo.position.y = (cap.height / 2) / this.modelScale - this.feetOffsetY;
  }

  /** Distant remotes shouldn't pay the skinned shadow-pass vertex cost —
   *  nobody reads a 200m figure's cast shadow. */
  setCastShadow(on: boolean): void {
    for (const m of this.skinnedMeshes) m.castShadow = on;
  }

  // Offscreen remotes skip the mixer entirely, so their bones are static —
  // freezing matrixAutoUpdate drops the whole rig out of updateMatrixWorld
  // (the rig is ~40 of the ~700 bone nodes walked per frame).
  private bones: THREE.Bone[] = [];

  setBonesFrozen(frozen: boolean): void {
    for (const b of this.bones) {
      b.matrixAutoUpdate = !frozen;
      if (frozen) b.updateMatrix();
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
      a = this.mixer!.clipAction(new THREE.AnimationClip(src.name + '.far', src.duration, tracks));
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
      ...this.aimBones.map(b => b.bone),
      ...this.steadyBones.map(b => b.bone),
      ...this.footSnaps.flatMap(f => [f.foot, f.shin, f.tip]),
    ];
    for (const k of keys) {
      for (let o = k; o && o !== this.model; o = o.parent!) essential.add(o);
    }
    this.distalBones = this.bones.filter(b => {
      if (essential.has(b)) return false;
      const nb = normBone(b.name);
      return PlayerModel.HELPER_BONES.test(nb) || !PlayerModel.LIMB_BONES.test(nb);
    });
    this.distalNameSet = new Set(this.distalBones.map(b => normBone(b.name)));
    // Model may finish loading while a far LOD is already armed.
    if (this.distalFrozen) this.setDistalFrozen(true);
  }

  setDistalFrozen(frozen: boolean): void {
    const was = this.distalFrozen;
    this.distalFrozen = frozen;
    for (const b of this.distalBones) {
      b.matrixAutoUpdate = !frozen;
      if (frozen) b.updateMatrix();
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
    for (const [base, far] of this.farActions) if (far === a) return base;
    return a;
  }

  /** Far-LOD swap: mannequin_lod1.glb is the same rig decimated ~80% —
   *  geometry carries the skin weights, so swapping geo alone keeps the
   *  pose. The skeleton/mixer is untouched. Only exists for 'mannequin'. */
  setLod(level: 0 | 1): void {
    // The decimated rig is mannequin-only — LOD-swapping it onto a class
    // body would graft mannequin geometry onto a foreign skeleton.
    if (this.variant !== 'mannequin') return;
    if (level === this.lod) return;
    this.lod = level;
    if (level === 0 || !this.lodGeos) { this.applyLodGeos(); return; }
    if (!this.lodLoadP) {
      this.lodLoadP = new GLTFLoader().loadAsync(RIG_MANIFEST[this.variant].lodUrl!).then((g) => {
        const geos: THREE.BufferGeometry[] = [];
        g.scene.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) geos.push(smoothShade((o as THREE.SkinnedMesh).geometry));
        });
        this.lodGeos = geos;
        if (this.lod === 1) this.applyLodGeos();
      }).catch(() => { this.lodLoadP = null; });
    }
  }

  private applyLodGeos(): void {
    if (this.lod === 1 && !this.lodGeos) return;
    const toLod = this.lod === 1;
    this.skinnedMeshes.forEach((m, i) => {
      if (toLod) {
        if (!m.userData.baseGeo) m.userData.baseGeo = m.geometry;
        const g = this.lodGeos![i];
        if (g) m.geometry = g;
      } else if (m.userData.baseGeo) {
        m.geometry = m.userData.baseGeo as THREE.BufferGeometry;
      }
      m.computeBoundingSphere();
      if (m.boundingSphere) m.boundingSphere.radius += 0.6;
    });
  }

  private prepareMesh(child: THREE.Mesh): void {
      child.castShadow = true;
      child.receiveShadow = true;
      child.geometry = smoothShade(child.geometry);
      // SkinnedMesh bind-pose bounds don't track bone-driven verts —
      // wrong bounds get it frustum-culled when it shouldn't be. Compute
      // the skinned bounds at load (three walks verts through the
      // skeleton) and pad for anim travel so culling can come back on.
      if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
        const sk = child as THREE.SkinnedMesh;
        this.skinnedMeshes.push(sk);
        sk.computeBoundingSphere();
        if (sk.boundingSphere) sk.boundingSphere.radius += 0.6;
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
    if (child.name === 'Head' || nb === 'defhead' || nb === 'head' || nb === 'righead') {
      this.aimBones.push({ bone: child, factor: 0.4, last: new THREE.Quaternion() });
    } else if (child.name === 'Abdomen' || nb === 'defspine001' || nb === 'spine' || nb === 'rigspine2') {
      this.aimBones.push({ bone: child, factor: 0.6, last: new THREE.Quaternion() });
    // GLTFLoader sanitizes names ('Palm2.R' -> 'Palm2R'); the
    // Quaternius rigs put the grip in FistR.
    } else if ((child.name === 'Palm2R' || nb === 'defhandr' || nb === 'fistr'
      || nb === 'handr' || nb === 'handright'
      || nb === 'rigpistolright' || nb === 'rigarmright3'
      || nb === 'basehumanrpalm') && !this.handBone) {
      this.handBone = child as THREE.Bone;
    }
    // Socket-gun rig arm chain — norms collapse the per-pack naming
    // (UpperArmr / Base_HumanRUpperarm / forearmr all land here).
    if (PlayerModel.HOLD_CHAINS) {
      for (let role = 0; role < PlayerModel.HOLD_CHAINS.length; role++) {
        const [norms, euler] = PlayerModel.HOLD_CHAINS[role]!;
        if (norms.has(nb)) {
          this.holdBones.push({ bone: child, role, off: new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler)), last: new THREE.Quaternion(), bind: child.quaternion.clone() });
          break;
        }
      }
    }
    // Foot-snap rig for retargeted clips on the robot rig (UAL
    // doesn't drive its IK foot bones). The mannequin's feet are
    // real in-chain bones — nothing to snap.
    if (child.name === 'FootL' || child.name === 'FootR') this.captureFootBone(child);
    if (PlayerModel.STEADY_BONES.has(nb)) {
      this.steadyBones.push({ bone: child, bind: child.quaternion.clone() });
    }
  }

  private captureFootBone(child: THREE.Object3D): void {
    const side = child.name === 'FootL' ? 'L' : 'R';
    const shin = this.model!.getObjectByName(`LowerLeg${side}`);
    const tip = this.model!.getObjectByName(`LowerLeg${side}_end`);
    if (shin && tip) this.footSnaps.push({ foot: child, shin, tip });
  }

  // Procedural gun in the right hand — follows every animation.
  // One merged geometry + shared material per remote: two meshes each
  // used to cost a draw call apiece (~17 remotes = ~34 draws).
  private static _gunGeo: THREE.BufferGeometry | null = null;
  private static _gunMat: THREE.MeshStandardMaterial | null = null;
  private attachGun(mann: boolean): void {
    const classGun = CLASS_BODY_SPEC[this.variant]?.gunLocal;
    const handBone = this.handBone;
    if (!handBone && !classGun) return;
    // Socket rigs without native armed anims get the canned grip pose —
    // rigs with their own rifle-hold clips (scifisoldier/polyart) don't
    // need arms posed on top of them.
    this.wantHoldPose = !CLASS_BODY_SPEC[this.variant]?.anims && !!handBone;
    if (!PlayerModel._gunMat) {
      PlayerModel._gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.55, metalness: 0.6, emissive: 0x334455, emissiveIntensity: 0.8 });
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
      if (this.heldWeapon >= 0) this.setWeapon(this.heldWeapon);
      return;
    }
    const ws = handBone!.getWorldScale(new THREE.Vector3());
    logger.debug(`GUN ATTACH`, { hand: handBone!.name, worldScale: ws.x, aimBones: this.aimBones.length });
    this.gun.scale.setScalar(0.7 / ws.x); // ~0.7m gun in world space
    this.gunBaseZ = 0.05 / ws.x;
    this.gunKickZ = 0.15 / ws.x; // recoil distance in bone units
    this.gunUnit = 1 / ws.x;
    this.gunBaseY = 0.05 * this.gunUnit;
    this.gun.position.set(0, this.gunBaseY, this.gunBaseZ);
    // Robot palm bones: barrel forward = local -Z flipped by π yaw.
    // UAL hand bones (measured via gun-math probe under the live aim
    // pose): barrel -X on plain yaw is the sideways look. X-90 sends the
    // barrel forward along the aim axis; Z180 rolls the top rail back up.
    // Class-body hand bones (cyber/vexa): measured on the posedump loop —
    // the palm's axes differ per rig family, tune via debugSetGunRot.
    if (mann) { this.gun.rotation.set(Math.PI / 2, 0, 0); this.gunBaseX = Math.PI / 2; }
    else {
      // Hand-local mount eulers solved per rig on the posedump loop —
      // palm axes differ per family. Written to gunBaseQuat so fx
      // envelopes compose on top instead of stomping rotation.x/z.
      const mount = PlayerModel.GUN_MOUNT_QUAT[this.variant];
      if (mount) {
        this.gunBaseQuat = new THREE.Quaternion(mount[0], mount[1], mount[2], mount[3]);
        this.gun.quaternion.copy(this.gunBaseQuat);
      } else {
        this.gun.rotation.y = Math.PI;
      }
      const mp = PlayerModel.GUN_MOUNT_POS[this.variant];
      if (mp) {
        this.gunRestX = mp[0];
        this.gunBaseY = mp[1];
        this.gunBaseZ = mp[2];
        this.gun.position.set(mp[0], mp[1], mp[2]);
      }
    }

    // Muzzle flash: additive sprite at the barrel tip, flashed on
    // fire() and faded in update(). Cheap (one sprite per remote),
    // blooms nicely at distance — this is what makes remote fire
    // readable when tracking small targets in the sky.
    this.muzzleFlash = ModelFx.buildMuzzleFlash();
    this.gun.add(this.muzzleFlash);

    handBone!.add(this.gun);
    if (this.heldWeapon >= 0) this.setWeapon(this.heldWeapon);
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
      if (mann && isLayeredClip(clip.name)) {
        clip.tracks = clip.tracks.filter(t =>
          !AIM_BONE_MASK.has(normBone(t.name.slice(0, t.name.indexOf('.')))));
        dampenSway(clip, SWAY_BONES);
      }
    }
    const action = this.mixer!.clipAction(clip);
    this.animations.set(clip.name, action);
    if (mann) this.animations.set('UAL_' + clip.name, action);
  }

  /** Build the masked aim layer: Pistol_Aim_* clips filtered down to
   *  the arm chain so they pose the weapon hold over any locomotion clip. LoopOnce+clamp — they are static poses, so they
   *  play once and hold at full weight set per frame from aimPitch. */
  private buildAimLayer(): void {
    const mk = (name: string): THREE.AnimationAction | null => {
      const src = this.animations.get(name)?.getClip();
      if (!src) return null;
      const tracks = src.tracks.filter(t =>
        AIM_BONE_MASK.has(normBone(t.name.slice(0, t.name.indexOf('.')))));
      if (!tracks.length) return null;
      const clip = new THREE.AnimationClip(name + '.aim', src.duration, tracks);
      const a = this.mixer!.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.setEffectiveWeight(0);
      a.play();
      return a;
    };
    this.aimUp = mk('Pistol_Aim_Up') ?? mk('UAL_Pistol_Aim_Up');
    this.aimNeutral = mk('Pistol_Aim_Neutral') ?? mk('UAL_Pistol_Aim_Neutral');
    this.aimDown = mk('Pistol_Aim_Down') ?? mk('UAL_Pistol_Aim_Down');
    if (!this.aimNeutral) logger.debug('Aim layer unavailable — no Pistol_Aim clips');
  }

  /** Authored clips can bake a facing turn into the hip track — the
   *  polyart pack's Idle_Ducking_ar carries the body at +95° vs the
   *  ~-138° every other clip agrees on, so skiing flipped him toward
   *  the camera. Measure each clip's first key on the animated hip
   *  node, take the set's modal yaw as the rig's forward convention,
   *  and unwind outliers (>~30°) back onto it in the node's parent
   *  frame. */
  private alignHipYaw(): void {
    if (!this.model) return;
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
        if (!tr.name.endsWith('.quaternion')) continue;
        const node = this.model!.getObjectByName(tr.name.slice(0, -'.quaternion'.length));
        if (!node) continue;
        if ((node as THREE.Bone).isBone && (!best || this.depthOf(node) < this.depthOf(best.node))) best = { tr, node };
        if (!any || this.depthOf(node) < this.depthOf(any.node)) any = { tr, node };
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
      const buckets = new Map<number, { sum: number; n: number }>();
      for (const [, a] of this.animations) {
        const hit = hipTrackOf(a.getClip());
        if (!hit) continue;
        const y = yawOf(hit.tr);
        const k = Math.round(y / (Math.PI / 18));
        const b = buckets.get(k) ?? { sum: 0, n: 0 };
        b.sum += y; b.n++;
        buckets.set(k, b);
      }
      let best = { sum: 0, n: 0 };
      for (const b of buckets.values()) if (b.n > best.n) best = b;
      return best.n ? best.sum / best.n : null;
    })();
    if (canonical === null) return;
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
      if (!hit?.node.parent) continue;
      let delta = fixRad !== 0 ? -fixRad : yawOf(hit.tr) - canonical;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      if (Math.abs(delta) < 0.5) continue;
      const parentQ = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().copy(this.model.matrixWorld).invert().multiply(hit.node.parent.matrixWorld));
      const fix = parentQ.clone().invert()
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -delta))
        .multiply(parentQ);
      const v = hit.tr.values;
      for (let i = 0; i < v.length; i += 4) {
        q.set(v[i], v[i + 1], v[i + 2], v[i + 3]).premultiply(fix);
        v[i] = q.x; v[i + 1] = q.y; v[i + 2] = q.z; v[i + 3] = q.w;
      }
      fixed.push(clip.name);
    }
    if (fixed.length) logger.debug(`Hip-yaw outliers corrected: ${fixed.join(', ')}`);
  }

  private depthOf(node: THREE.Object3D): number {
    let d = 0;
    for (let p = node.parent; p && p !== this.model; p = p.parent) d++;
    return d;
  }

  playAnimation(name: string, startPhase = 0): void {
    if (!this._loaded) { this._queuedAnim = name; return; }
    const base = this.animations.get(name);
    if (!base) {
      if (!this._warnedAnims.has(name)) {
        this._warnedAnims.add(name);
        logger.warn(`Animation not found: ${name}`);
      }
      // Zero-native-clip variants (cybersoldier) resolve every state to a
      // missing fallback until the async retarget bake lands — returning
      // with no action running holds the model at bind pose for the whole
      // window. Any real clip beats bind pose, so park on the idle loop
      // (or the first available clip) while the requested one is absent.
      if (!this.currentAction?.isRunning()) {
        const hold = this.animations.has('UAL_Idle_Loop') ? 'UAL_Idle_Loop' : this.animations.keys().next().value;
        if (hold) return this.playAnimation(hold);
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

    if (this.currentAction) {
      this.currentAction.fadeOut(0.2);
    }

    action.reset();
    // Pistol_Shoot's first ~180ms is a draw wind-up — an arm sweeps wide
    // before settling on target. Replayed every shot it reads as the
    // model spreading its arms each trigger pull. Skip to the aimed
    // frame and crossfade fast so the snap reads as recoil, not a draw.
    const isShoot = name === 'Pistol_Shoot' || name === 'UAL_Pistol_Shoot';
    if (isShoot) action.time = 0.18;
    // Direction flip mid-stride: enter the new clip at the previous clip's
    // cycle phase so the footfall doesn't restart mid-step.
    else if (startPhase > 0) action.time = startPhase * action.getClip().duration;
    action.fadeIn(isShoot ? 0.06 : 0.2);
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

  /** Facing-frame velocity → 8-way dir; when the KevDev directional clips
   *  baked, walk/run re-resolves onto the matching stride (phase carried
   *  over so the footfall doesn't pop). Returns true while a dedicated
   *  clip drives the motion — callers drop the reverse/lean fallbacks. */
  setLocomotionVector(fwd: number, side: number): boolean {
    const dir = DIR8[((Math.round(Math.atan2(side, fwd) / (Math.PI / 4)) % 8) + 8) % 8];
    if (dir !== this.locoDir) {
      this.locoDir = dir;
      if (this.currentState === 'walk' || this.currentState === 'run')
        this.forceAnimationState(this.currentState, true);
    }
    return this.dirClipActive;
  }

  // Locomotion direction: sectors without a dedicated clip run the
  // walk/run clip in reverse (the UE "Rate Scale -1" blendspace trick —
  // the footstep phase flips too, which is what kills the moonwalk look).
  setLocomotionReversed(rev: boolean): void {
    const a = this.currentAction;
    if (!a) return;
    const sign = rev ? -1 : 1;
    if (Math.sign(a.timeScale || 1) === sign) return;
    const dur = a.getClip().duration;
    a.time = dur - a.time; // preserve the cycle phase across the flip
    a.timeScale = Math.abs(a.timeScale || 1) * sign;
  }

  get animationState(): AnimationState {
    return this.currentState;
  }

  setAnimationState(state: AnimationState): void {
    if (this.currentState === state) return;
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
      if (!last && !this.animations.has(c.name)) continue;
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
    if (!this.model) return;
    const model = this.model;
    const adopt = (baked: Map<string, THREE.AnimationClip>) => {
      if (this._disposed || !this.mixer || !this.model) return;
      // Baked clips arrive fully cooked — hip-XZ strip and the
      // mannequin aim-layer carve are applied at bake time.
      for (const [name, clip] of baked) {
        this.animations.set(name, this.mixer.clipAction(clip));
      }
      // Baked clips land AFTER the load-time alignHipYaw ran — for
      // retarget-only rigs that pass saw an empty table and did nothing.
      // Re-run so the bake's own hip convention gets canonicalized.
      if (CLASS_BODY_SPEC[this.variant]) this.alignHipYaw();
      // Re-resolve the current state onto the better clip if one landed —
      // the baked names now sit in the same candidate table the state
      // resolver reads, so let it pick (a bare 'Idle' name doesn't exist
      // on every rig).
      this.forceAnimationState(this.currentState);
    };
    const runtimeBake = () =>
      bakeUALClips(model, this.variant).then(adopt)
        .catch((e) => { logger.warn('UAL bake failed for ' + this.variant, e); });
    // The offline bake (public/assets/anims/<variant>.glb) ships the
    // whole retarget so load never flashes bind pose or burns a
    // resample; missing file → dev rigs still runtime-bake.
    loadBakedUALClips(this.variant).then(baked => {
      if (baked && baked.size) adopt(baked);
      else void runtimeBake();
    }).catch(runtimeBake);
  }

  update(dt: number): void {
    // Remove last frame's pitch BEFORE the mixer writes. The mixer skips
    // bones whose track value didn't change, so without this the multiply
    // would accumulate on a stale pitched value and the bone spins.
    for (const ab of this.aimBones) {
      ab.bone.quaternion.multiply(_pitchQuat.copy(ab.last).invert());
    }
    for (const hb of this.holdBones) {
      hb.bone.quaternion.multiply(_pitchQuat.copy(hb.last).invert());
    }
    // Masked aim layer — weights must land BEFORE mixer.update samples the
    // pose. Suppressed while a full-body oneshot (shoot/hit/death) owns the
    // arms so it doesn't fight the reaction pose.
    let procPitch = this.aimPitch;
    if (this.aimNeutral) {
      const t = Math.max(-1, Math.min(1, this.aimPitch / PlayerModel.AIM_CLIP_RAD));
      // Suppress only while the oneshot actually OWNS the arms: during
      // fadeOut the clip is still isRunning but its weight is decaying —
      // suppressing on isRunning alone left the arm chain un-driven for
      // ~200ms after every shot (arms drifted toward bind pose = the
      // "opens hands, almost T-pose" on each trigger pull). Death clamps
      // at full weight so its suppression still holds forever.
      const a = this.currentAction;
      const oneshot = !!a?.isRunning() && a.getEffectiveWeight() > 0.5 &&
        (!!this.currentClipName && (ONESHOT_CLIPS.has(this.currentClipName) || this.currentClipName === 'UAL_Death01'));
      const w = oneshot ? 0 : 1;
      this.aimNeutral.setEffectiveWeight((1 - Math.abs(t)) * w);
      this.aimUp?.setEffectiveWeight(Math.max(0, t) * w);
      this.aimDown?.setEffectiveWeight(Math.max(0, -t) * w);
      // The clips cover ±AIM_CLIP_RAD; procedural pitch tops up the rest.
      procPitch = this.aimPitch - t * PlayerModel.AIM_CLIP_RAD;
    }
    if (this.mixer) {
      this.mixer.update(dt);
    }
    this.applySpineLock(dt);
    if (this.wantHoldPose) {
      // Full-body oneshots own the arms while weighted in. Everything
      // else keeps the hold: cyber's retargeted clips pose the arm chain
      // wrong on their own (mannequin axis bake lands splayed), so the
      // fixed hip-fire grip IS the correction — blend only so oneshot
      // transitions don't pop.
      const a = this.currentAction;
      const oneshot = !!a?.isRunning() && a.getEffectiveWeight() > 0.5 &&
        (!!this.currentClipName && (ONESHOT_CLIPS.has(this.currentClipName) || this.currentClipName === 'UAL_Death01'));
      this.holdW += (oneshot ? -6 : 6) * dt;
      this.holdW = Math.min(1, Math.max(0, this.holdW));
      if (this.holdW > 0) for (const hb of this.holdBones) {
        // Slerp toward BIND pose first — composing the fixed raise on top
        // of the animated track means the arm flails with every clip
        // frame (the retargeted tracks are garbage on this rig anyway).
        hb.bone.quaternion.slerp(hb.bind, this.holdW);
        hb.last.identity().slerp(hb.off, this.holdW);
        hb.bone.quaternion.multiply(hb.last);
      }
    }
    for (const ab of this.aimBones) {
      // Negative X tilts up for positive pitch (looking up)
      ab.last.setFromAxisAngle(X_AXIS, -procPitch * ab.factor);
      ab.bone.quaternion.multiply(ab.last);
    }
    this.snapFeetToShins();
    this.fx.tick(dt);
  }

  // Spine lock while firing: slerp the torso chain back to bind pose.
  // Post-mixer so the clip's residual (post-dampenSway) stride roll
  // can't drag the aimed arm chain side to side; ~0.45s per shot so
  // continuous fire holds the lock.
  private applySpineLock(dt: number): void {
    this.armedT = Math.max(0, this.armedT - dt);
    this.armed += ((this.armedT > 0 ? 1 : 0) - this.armed) * Math.min(dt * 12, 1);
    if (this.armed > 0.01) {
      for (const sb of this.steadyBones) sb.bone.quaternion.slerp(sb.bind, this.armed);
    }
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

  /** Barrel-tip world point — third-person beam/tracer anchor. */
  muzzleWorld(out: THREE.Vector3): boolean {
    if (!this.muzzleFlash) return false;
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
    if (wt === undefined) return;
    // Weapon switches fire before the GLB loads (spawn loadout races the
    // async mesh) — stash the pick on heldWeapon so attachGun's tail can
    // re-apply it the moment a gun mount exists instead of dropping it.
    this.heldWeapon = wt;
    if (!this.gunMesh) return;
    const geo = handWeaponGeo(wt) ?? PlayerModel._gunGeo!;
    if (this.gunMesh.geometry === geo) return;
    this.gunMesh.geometry = geo;
    // Flash rides the baked model's real muzzle, not a fixed offset —
    // each baked geo already carries its bounding box from the baker.
    if (this.muzzleFlash && geo.boundingBox) {
      this.muzzleFlash.position.set(0, 0.05, geo.boundingBox.max.z + 0.08);
    }
  }

  /** Damage white-pop — creature-style hit readability on the robot body. */
  damageFlash(): void { this.fx.damageFlash(); }

  // Procedural fire kick + muzzle flash — call when the remote player shoots.
  fire(weaponType?: number): void {
    this.armedT = 0.45;
    // A shot reveals the held weapon — swapping the prop first means the
    // muzzle flash frames the right barrel.
    if (weaponType !== undefined && weaponType !== WeaponType.Melee) this.setWeapon(weaponType);
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
    if (!this.model) return false;
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

  // Ghost shimmer — translucent material override for the decloak-reveal.
  // Baselines are captured once so restore hands every material its own
  // state back (GLBs share materials across meshes).
  private ghostBaseline: Map<THREE.Material, { transparent: boolean; opacity: number; depthWrite: boolean }> | null = null;
  setGhost(on: boolean): void {
    if (!this.model) return;
    if (on) {
      if (this.ghostBaseline) return;
      this.ghostBaseline = new Map();
      this.model.traverse((child) => {
        const mat = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) {
          this.ghostBaseline!.set(m, { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite });
          m.transparent = true;
          m.opacity = 0.28;
          m.depthWrite = false;
        }
      });
      return;
    }
    if (!this.ghostBaseline) return;
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
    if (this.colliderGizmo) this.colliderGizmo.visible = this.colliderShown && urlParams.debug;
  }

  private colliderShown = true;
  setColliderVisible(visible: boolean): void {
    this.colliderShown = visible;
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
    // Class bodies carry the class silhouette in the GLB itself — a
    // _classScale bump on top would double the tiering.
    if (CLASS_BODY_SPEC[this.variant]) return;
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
      this.colliderMat = null;
    }
  }
}
