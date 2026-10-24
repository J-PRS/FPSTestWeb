import * as THREE from 'three';
import { mkGltfLoader, loadGltfCached } from '../gltfLoad';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

import { PLAYER_RADIUS, CAPSULE_CYLINDER_HEIGHT, CAPSULE_CENTER_Y } from '../core/config.js';
import { urlParams } from '../core/params.js';

import { ChildLogger } from '../core/Logger.js';
import { glitch } from '../core/fxDiag.js';
import { buildGibParts, bakeDeathParts, type GibPart } from './playerGibs.js';

import { CLASS_BODY_SPEC, RIG_MANIFEST, ONESHOT_CLIPS,
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
import { bakeVertexAO } from '../effects/vertexAO.js';
import { WeaponType } from '../../../shared/weapons.js';
const logger = new ChildLogger('PlayerModel');

// Rig URLs whose cached template already carries the gunmetal bake —
// the bake mutates shared geometry, so it must run exactly once per URL.
const gunmetalBaked = new Set<string>();
const gunmetalBake = new Map<string, Promise<void>>();

// Locomotion clip surgery (stripHipXZ/dampenSway/DIR8) lives in
// playerClipSurgery.ts — extracted so the layered-anim carve-up is
// testable without loading the rig.

export type { AnimationState } from './playerClips.js';

export type PlayerModelVariant = 'robot' | 'mannequin' | 'knight' | 'scifisoldier' | 'cybersoldier' | 'vexa' | 'polyart' | 'brute' | 'juggernaut' | 'juggernaut_og' | 'juggernaut_brick' | 'juggernaut_wedge' | 'juggernaut_bld' | 'juggernaut_kit' | 'juggernaut_scp' | 'juggernaut_shell' | 'light_scp' | 'light_plate' | 'light_brick' | 'light_shell' | 'dreadnought' | 'brawler' | 'scout';

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
  debugSetHold(upper: [number, number, number], lower: [number, number, number], hand: [number, number, number], lUpper: [number, number, number] = upper.map((v): number => -v) as [number, number, number], lLower: [number, number, number] = lower, lHand: [number, number, number] = hand): void {
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
  get gunAimPin(): boolean { return this.gunCtl.aimPin; }
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
    // Mannequin never plays a shoot clip — its aimPin prop is the shot
    // feedback, and the bind-pose torso slerp only yanks the body off-aim.
    this.pose.wantSpineLock = this.variant !== 'mannequin' && (!shootClip || shootClip.startsWith('UAL_'));
    // The gun controller owns the mesh; a baked-geo swap invalidates the
    // wireframe capture, so it reaches back through this hook.
    this.gunCtl.onGeoSwap = (): void => {
      if (this.mats.wireframeOn) {this.mats.captureWireframe(this.model);}
      this.rebuildGunHulls(); // swapped prop geo invalidates its outline clones
    };
  }

  async load(): Promise<void> {
    const loader = mkGltfLoader();
    const mann = this.variant === 'mannequin';
    const knight = this.variant === 'knight';
    const url = RIG_MANIFEST[this.variant]?.url ?? '/assets/models/RobotExpressive.glb';

    return new Promise((resolve, reject): void => {
      let attempts = 0;
      let fellBack = false;
      const attempt = (): void => {
      // One parse per rig URL for the whole session — SkeletonUtils.clone
      // hands each remote its own skeleton bound to shared geometry and
      // textures. A roomful of same-class bots used to pay a full GLB
      // decode + GPU upload apiece.
      loadGltfCached(loader, url).then(
        (gltf): void => {
          if (this._disposed) { resolve(); return; }
          // Worn-gunmetal rigs: matte recipe is cheap — flatten the
          // template's metalness synchronously so the clone inherits it.
          // The AO+wear+grime BAKE is expensive (~1s), so it runs on the
          // next macrotask: the model shows immediately, the grunge lands
          // a beat later via mats.rearm (clones share baked geometry, and
          // rearm copies the shader hook + tex refs onto material clones).
          const gunmetal = RIG_MANIFEST[this.variant]?.gunmetal;
          if (gunmetal && !gunmetalBaked.has(url)) {
            gunmetalBaked.add(url);
            gltf.scene.traverse((o): void => {
              const mesh = o as THREE.Mesh;
              if (!mesh.isMesh) {return;}
              for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                const sm = m as THREE.MeshStandardMaterial;
                if (sm.isMeshStandardMaterial) {sm.metalness = 0.1; sm.roughness = 0.72; sm.userData.__wearInt = 2.5;}
              }
            });
            gunmetalBake.set(url, new Promise((res): void => {
              setTimeout((): void => { bakeVertexAO(gltf.scene as THREE.Group, { grime: true, wearBoost: 0.5, edgeAngle: 28 }); res(); }, 0);
            }));
          }
          this.onModelLoaded({ scene: SkeletonUtils.clone(gltf.scene) as THREE.Group, animations: gltf.animations.map((c): THREE.AnimationClip => c.clone()) }, mann, knight);
          resolve();
          if (gunmetal) {
            gunmetalBake.get(url)!.then((): void => {
              if (!this._disposed) {this.model?.traverse((o): void => { if ((o as THREE.Mesh).isMesh) {this.mats.rearm(o as THREE.Mesh);}});}
            });
          }
        return; },
        (error): void => {
          // A dev-server restart (or any transient fetch failure) must not
          // kill the model for the whole session — an invisible player is
          // worse than a late one. Retry with backoff before giving up.
          if (this._disposed) { resolve(); return; }
          if ((attempts += 1) <= 4) {
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
            this.pose.wantSpineLock = this.variant !== 'mannequin' && (!fbShoot || fbShoot.startsWith('UAL_'));
            // oxlint-disable-next-line promise/no-nesting -- executor forwards the fallback rig's load outcome
            this.load().then(resolve, reject).catch((): void => undefined);
            return;
          }
          logger.error('Failed to load', error);
          reject(error);
        }
      ).catch((error): void => {
        // Never silent: a throw while BUILDING a body (before any clip is
        // registered and before it joins the scene) used to be swallowed
        // whole — the model simply never appeared and nothing was logged.
        logger.error('Model load chain failed', error);
      });
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
    this.model.traverse((c): void => (c as THREE.SkinnedMesh).skeleton?.update());
    const box = new THREE.Box3().setFromObject(this.model, true);
    const size = box.getSize(new THREE.Vector3());
    const {min} = box;
    const {max} = box;
    logger.debug(`Model bounding box: size=(${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)}) min=(${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}) max=(${max.x.toFixed(2)},${max.y.toFixed(2)},${max.z.toFixed(2)})`);

    // Enable shadow casting + grab aim/attachment bones
    this.model.traverse((child): void => this.prepareChild(child));
    this.shareDrivenSkeleton(gltf.animations);
    this.unifySkeletons();
    this.mergeSkinnedParts();
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
    this.pose.buildAimLayer(this.anim.mixer!, this.anim.animations, mann || Boolean(RIG_MANIFEST[this.variant]?.aimMask));

    logger.debug('Loaded animations:', Array.from(this.anim.animations.keys()));

    // Rest-pose snapshot — local TRS per bone while nothing has driven
    // them yet. skeleton.pose() can't be trusted on rewritten skins
    // (its boneInverses live in the donor's bind frame); this restores
    // the authored T-pose in local space, frame-agnostic.
    this._restPose = new Map();
    this.model.traverse((c): void => {
      if ((c as THREE.Bone).isBone) {
        this._restPose!.set(c as THREE.Bone, { p: c.position.clone(), q: c.quaternion.clone(), s: c.scale.clone() });
      }
    });

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
  private readonly _bbMin = new THREE.Vector3();
  /** merged-mesh i → original part indices — remapLod merges the lod1
   *  geo list into the same buckets so the swap stays aligned. */
  private lodGeoBuckets: number[][] | null = null;
  private readonly lodCtl = new PlayerModelLod(this.skinnedMeshes,
    () => mkGltfLoader().loadAsync(RIG_MANIFEST[this.variant].lodUrl!).then((g): THREE.BufferGeometry<THREE.NormalBufferAttributes, THREE.BufferGeometryEventMap>[] => {
      const geos: THREE.BufferGeometry[] = [];
      g.scene.traverse((o): void => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) {geos.push(smoothShade((o as THREE.SkinnedMesh).geometry));}
      });
      return geos;
    }),
    (gs) => this.mergedLodGeos(gs));

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
    // Do NOT touch this.model.matrixWorldAutoUpdate: freezing the root
    // strand also freezes position tracking (setPosition writes
    // model.position, but matrixWorld never recomposes — the mesh keeps
    // rendering where it froze, and its stale bounds keep it
    // frustum-culled even after the player runs back onscreen). The
    // mixer skip upstream already removes the anim cost.
  }

  /** class_heavy-style GLBs ship each body part bound to its OWN copy of
   *  the same armature (5 skins × 57 identically-named joints). The
   *  mixer's PropertyBinding resolves duplicate node names to the first
   *  DFS match, so only one armature animates — the other parts render
   *  frozen bind-pose copies stacked on the driven body (the "magenta
   *  blob" + model-offset sink). Joint order is identical across the
   *  copies, so rebind every part's Skeleton to the driven armature's
   *  bone NODES while keeping each part's own inverse bind matrices. */
  private shareDrivenSkeleton(clips: THREE.AnimationClip[]): void {
    if (!this.model || this.skinnedMeshes.length < 2) {return;}
    // A track name's root node resolves to the first DFS match — find
    // that node, then the skeleton that owns it is the driven armature.
    const trackNode = clips.flatMap((c): string[] => c.tracks.map((t): string => t.name.split('.')[0]!)).find((n): boolean => Boolean(n));
    let drivenBone: THREE.Object3D | undefined;
    if (trackNode) {
      this.model.traverse((c): void => { if (!drivenBone && c.name === trackNode) {drivenBone = c;} });
    }
    const donor = drivenBone
      ? this.skinnedMeshes.find((sm): boolean => sm.skeleton.bones.includes(drivenBone as THREE.Bone))
      : undefined;
    const {bones} = (donor ?? this.skinnedMeshes[0]!).skeleton;
    for (const sm of this.skinnedMeshes) {
      if (sm.skeleton.bones === bones) {continue;}
      // Different rig (names or count differ) — not a duplicate copy.
      if (sm.skeleton.bones.length !== bones.length
        || sm.skeleton.bones.some((b, i): boolean => b.name !== bones[i]!.name)) {continue;}
      sm.bind(new THREE.Skeleton(bones, sm.skeleton.boneInverses), sm.bindMatrix);
    }
  }

  /** Every skinned PART is its own draw call sharing one skeleton —
   *  5-10 parts per remote ≈ most of the scene's draw mass. Merge parts
   *  that share material + bindMatrix + parent + local transform into
   *  one SkinnedMesh per bucket; anything that doesn't match stays
   *  unmerged rather than risk a visual diff. Same verts, same skin —
   *  fewer submissions. */
  /** Class GLBs ship each primitive with its own skin — N identical bone
   *  sets per body means N skeleton.update passes per render frame and
   *  parts can never merge (skeleton is a bucket key). When every part's
   *  joint array is the same names in the same order, one Skeleton serves
   *  them all — bind matrices are per-mesh and preserved. Runs before
   *  mergeSkinnedParts so same-material parts can now collapse. */
  private unifySkeletons(): void {
    const parts = this.skinnedMeshes;
    if (parts.length < 2) {return;}
    const primary = parts[0]!.skeleton;
    if (!primary) {return;}
    const jointKey = primary.bones.map((b): string => b.name).join('|');
    for (const sm of parts.slice(1)) {
      if (!sm.skeleton || sm.skeleton === primary) {continue;}
      if (sm.skeleton.bones.map((b): string => b.name).join('|') === jointKey) {
        sm.bind(primary, sm.bindMatrix);
      }
    }
  }

  private mergeSkinnedParts(): void {
    const parts = this.skinnedMeshes;
    if (parts.length < 2) {return;}
    const buckets = new Map<string, THREE.SkinnedMesh[]>();
    for (const sm of parts) {
      const mats = Array.isArray(sm.material) ? sm.material : [sm.material];
      if (mats.length !== 1) {return;} // multi-material part — leave the whole model split
      const m = mats[0]!;
      const key = [
        m.name, m.type,
        // Skeleton identity is part of the bucket: a multi-skin GLB
        // (class_heavy ships 5 meshes each with its own skin) merged into
        // one mesh can only bind ONE skeleton, so the rest deform against
        // foreign bones. Same-skeleton parts still merge (the draw-call
        // win); cross-skeleton parts stay split.
        sm.skeleton?.uuid ?? '',
        sm.bindMatrix.elements.join(','),
        sm.position.toArray().join(','), sm.quaternion.toArray().join(','), sm.scale.toArray().join(','),
        sm.parent?.uuid ?? '',
      ].join('|');
      let b = buckets.get(key);
      if (!b) {buckets.set(key, b = []);}
      b.push(sm);
    }
    if (buckets.size === parts.length) {return;} // nothing shares — merge would save nothing
    // Plan every bucket first — a mid-merge attribute failure aborts
    // before any part leaves the scene.
    const merged: THREE.SkinnedMesh[] = [];
    const geoBuckets: number[][] = [];
    const detach: THREE.SkinnedMesh[] = [];
    for (const grp of buckets.values()) {
      if (grp.length === 1) {
        merged.push(grp[0]!);
        geoBuckets.push([parts.indexOf(grp[0]!)]);
        continue;
      }
      const geo = mergeGeometries(grp.map((s): THREE.BufferGeometry => s.geometry), false);
      if (!geo) {return;} // attribute mismatch — keep the whole model split
      const mm = new THREE.SkinnedMesh(geo, grp[0]!.material);
      mm.name = `merged:${grp[0]!.name}+${grp.length - 1}`;
      mm.bind(grp[0]!.skeleton, grp[0]!.bindMatrix.clone());
      mm.castShadow = grp[0]!.castShadow;
      mm.receiveShadow = grp[0]!.receiveShadow;
      mm.frustumCulled = grp[0]!.frustumCulled;
      // baseGeo stash must be the merged BASE geo — if lod1 was already
      // applied, current geometry is the decimated one.
      if (grp.some((s): boolean => Boolean(s.userData.baseGeo))) {
        const base = mergeGeometries(grp.map((s): THREE.BufferGeometry => (s.userData.baseGeo as THREE.BufferGeometry) ?? s.geometry), false);
        if (base) {mm.userData.baseGeo = base;}
      }
      mm.computeBoundingSphere();
      if (mm.boundingSphere) {mm.boundingSphere.radius += 0.6;}
      mm.userData.srcParent = grp[0]!.parent;
      merged.push(mm);
      detach.push(...grp);
      geoBuckets.push(grp.map((s): number => parts.indexOf(s)));
    }
    // All buckets planned — swap the graph in one shot.
    for (const mm of merged) {
      if (mm.name.startsWith('merged:')) {
        (mm.userData.srcParent as THREE.Object3D | null)?.add(mm);
        delete mm.userData.srcParent;
      }
    }
    for (const s of detach) {s.removeFromParent();}
    this.skinnedMeshes.length = 0;
    this.skinnedMeshes.push(...merged);
    this.lodGeoBuckets = geoBuckets;
  }

  /** remapLod hook — merges the lod1 geo list into the same material
   *  buckets mergeSkinnedParts produced. Identity until buckets exist. */
  private mergedLodGeos(gs: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
    const b = this.lodGeoBuckets;
    if (!b) {return gs;}
    return b.map((idxs): THREE.BufferGeometry => {
      if (idxs.length === 1) {return gs[idxs[0]!]!;}
      const merged = mergeGeometries(idxs.map((i): THREE.BufferGeometry => gs[i]!), false);
      return merged ?? gs[idxs[0]!]!;
    });
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
    // Aim-pin rigs hold the same gripped torso through ground loco —
    // the aim layer already owns the masked quats, this pins what the
    // loco clip still sways.
    this.pose.lockLocoTorso = Boolean(RIG_MANIFEST[this.variant]?.mount?.aimPin);
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

  forceAnimationState(state: AnimationState, keepPhase = false): void { this._bindHeld = false; this.anim.forceAnimationState(state, keepPhase); }

  /** Snap every bone back to the authored rest pose — the rig's T-pose.
   *  Held: update() keeps re-posing the skeleton until a clip runs again. */
  private _bindHeld = false;
  private _restPose: Map<THREE.Bone, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }> | null = null;
  setBindPose(): void {
    this._bindHeld = true;
    this.anim.mixer?.stopAllAction();
    if (this._restPose) {
      for (const [b, r] of this._restPose) {
        b.position.copy(r.p); b.quaternion.copy(r.q); b.scale.copy(r.s);
      }
      this.model?.updateMatrixWorld(true);
    }
  }

  update(dt: number): void {
    if (this._bindHeld) {
      if (this._restPose) {
        for (const [b, r] of this._restPose) {
          b.position.copy(r.p); b.quaternion.copy(r.q); b.scale.copy(r.s);
        }
        this.model?.updateMatrixWorld(true);
      }
      this.gunCtl.follow(dt, this.model, this.modelScale, this.handBoneL, this.pose.aimPitch);
      this.fx.tick(dt);
      return;
    }
    this.anim.tick(dt);
    this.gunCtl.follow(dt, this.model, this.modelScale, this.handBoneL, this.pose.aimPitch);
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
    let maxMesh: THREE.SkinnedMesh | undefined;
    let minBoneY = Infinity;
    for (const sm of this.skinnedMeshes) {
      // Per-skeleton spread, not pooled: duplicate-armature rigs (polyart
      // ships 5) park their unused skeletons at bind pose far from the
      // driven one — cross-skeleton distance reads as stretch without a
      // single vert moving.
      // Sink/rise measures the POSED VERTEX bounds, not bones — rigs
      // park utility bones (weapon/headgear anchors) meters off the body
      // at bind pose; verts are what markers have to register against.
      sm.computeBoundingBox();
      const bb = sm.boundingBox;
      if (bb) {
        this._bbMin.copy(bb.min).applyMatrix4(sm.matrixWorld);
        if (this._bbMin.y < minBoneY) {minBoneY = this._bbMin.y;}
      }
      const {bones} = sm.skeleton;
      let meshMax = 0, mi = -1, mj = -1;
      for (let i = 0; i < bones.length; i += 1) {
        const a = bones[i].matrixWorld.elements;
        for (let j = i + 1; j < bones.length; j += 1) {
          const b = bones[j].matrixWorld.elements;
          const dx = a[12] - b[12], dy = a[13] - b[13], dz = a[14] - b[14];
          const d = dx * dx + dy * dy + dz * dz;
          if (d > meshMax) { meshMax = d; mi = i; mj = j; }
        }
      }
      if (meshMax > maxSq) { maxSq = meshMax; bi = mi; bj = mj; maxMesh = sm; }
    }
    // Sink/rise canary — HUD markers aim at the logical capsule (feet +
    // head room), so a clip that drags the skeleton off the collider
    // reads as "marker at his feet" (mesh floated up) or "marker over
    // nothing" (mesh sank). Bones sit inside the mesh surface, so flag
    // only past a margin animation bob can't reach (~0.6m).
    if (this.model.parent) {
      // World-space compare — previews nest models under transformed
      // proxies, so the parent-local position.y isn't the world's feet.
      const feetY = this._bbMin.set(0, -this.feetOffsetY, 0).applyMatrix4(this.model.matrixWorld).y;
      const off = minBoneY - feetY;
      // Oneshot clips ARE designed displacement — Hit_Chest rocks the rig
      // ~0.8m back, Death slides the corpse, Pistol_Shoot's draw drops the
      // scout ~1.6m. That motion is the clip, not a float bug — gate on
      // clip membership, not state (a 'shoot' state's clip is a oneshot).
      // Crossfades get the same pass: the outgoing clip still holds weight
      // while the incoming name is already current (death→idle sweeps the
      // corpse pose under the feet for a few frames = phantom -1m sink).
      if (!this.anim.transitioning && !ONESHOT_CLIPS.has(this.anim.currentClipName ?? '') && Math.abs(off) > 0.6) {
        glitch('model-offset', { variant: this.variant, clip: this.anim.currentClipName ?? '?',
          state: this.anim.currentState, rise: Math.round(off * 10) / 10 });
      }
    }
    if (maxSq > 64) {
      const bn = maxMesh && bi >= 0 ? `${maxMesh.skeleton.bones[bi]?.name}↔${maxMesh.skeleton.bones[bj]?.name}` : '?';
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

  setRotation(yaw: number, pitch: number, roll = 0): void {
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
      this.model.traverse((child): void => {
        const mesh = child as THREE.Mesh;
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) {return;}
        this.ghostBaseline!.set(mesh, mat);
        mesh.material = Array.isArray(mat) ? mat.map((m): THREE.Material<THREE.MaterialEventMap> => PlayerModel.ghostOf(m)) : PlayerModel.ghostOf(mat);
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
  /** Team tint — hex lerps every body material toward the hue, null
   *  restores the authored palette. */
  setTeamTint(hex: number | null): void { this.mats.setTint(hex); }
  /** Fresnel rim experiment — emissive edge glow on the body mats; the
   *  hand prop's shared material is cloned per model so it rims too
   *  without leaking onto every other model's gun. */
  setRim(hex: number | null): void {
    const gm = this.gunCtl.mesh;
    if (gm && (gm.material as THREE.MeshStandardMaterial).isMeshStandardMaterial && !gm.userData.rimCloned) {
      gm.material = (gm.material as THREE.Material).clone();
      gm.userData.rimCloned = true;
      this.mats.extraRim.push(gm.material);
    }
    this.mats.setRim(hex);
  }

  // Inverted-hull outline: per SkinnedMesh a clone sharing the SAME
  // skeleton (animates for free, no geometry copy) with a flat BackSide
  // material whose vertex shader puffs verts along normals — every
  // plate expands on its own axes, which is the hull a hard-surface
  // model needs (uniform scale would drift the parts apart).
  private hullMat: THREE.MeshBasicMaterial | null = null;
  private readonly hulls: THREE.SkinnedMesh[] = [];
  private readonly gunHulls: THREE.Mesh[] = [];

  private rebuildGunHulls(): void {
    for (const h of this.gunHulls) {h.parent?.remove(h);}
    this.gunHulls.length = 0;
    if (!this.hullMat || this.hulls.length === 0) {return;}
    const g = this.gunCtl.group;
    if (!g) {return;}
    const src: THREE.Mesh[] = [];
    g.traverse((o): void => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh) {src.push(m);}
    });
    for (const m of src) {
      // Prop geos can ship without normals — that renders them flat black
      // AND NaNs the hull's normal-extrude (invisible). computeVertexNormals
      // fixes both; safe on the shared geo.
      if (!m.geometry.attributes.normal) {m.geometry.computeVertexNormals();}
      // Inverted hull cracks at hard edges when coincident verts carry
      // SPLIT normals (each face copy extrudes its own way). Weld a
      // hull-only copy BY POSITION ONLY (uv/face-normal splits would
      // veto the merge) so the extrude directions are smooth.
      // Body meshes skip this — they're already smooth-shaded and their
      // normals get skinned (a welded clone wouldn't animate).
      let hgeo = m.geometry;
      if (!m.geometry.index) {
        const posOnly = new THREE.BufferGeometry();
        posOnly.setAttribute('position', m.geometry.attributes.position);
        hgeo = mergeVertices(posOnly);
        hgeo.computeVertexNormals();
      }
      const h = new THREE.Mesh(hgeo, this.hullMat);
      h.position.copy(m.position); h.quaternion.copy(m.quaternion); h.scale.copy(m.scale);
      h.renderOrder = 2; h.frustumCulled = false;
      (m.parent ?? g).add(h);
      this.gunHulls.push(h);
    }
    for (const h of this.gunHulls) {h.visible = this.hulls[0]?.visible ?? false;}
  }

  /** Enemy outline — hex shows a normal-extruded silhouette drawn
   *  through occluders (depthTest off = wallhack read), null hides. */
  setOutline(hex: number | null): void {
    if (hex !== null && this.hulls.length === 0 && this.model) {
      if (!this.hullMat) {
        // Normal depth test: the inflated shell occludes behind the body
        // so only the silhouette rim survives — and the rim hides behind
        // walls with the body, matching the OW enemy rule (through-wall
        // is an ally privilege; wallhack-red enemies would be broken).
        this.hullMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, toneMapped: false });
        this.hullMat.onBeforeCompile = (sh): void => {
          // uHull stays tiny — only enough to un-z-fight the backfaces;
          // it rides model scale so a small rig's ring vanishes if it
          // does the visible work. uHullPx is NDC — same pixel rim on
          // every body at every distance.
          sh.uniforms.uHull = { value: 0.006 };
          // Rim width ∝ √distance — constant-px reads fat when bodies
          // shrink at range, world-constant vanishes; sqrt splits it.
          // 0.019 → ~2.5px at 10m, ~1px at 60m, ~0.5px past 120m.
          sh.uniforms.uHullPx = { value: 0.019 };
          sh.vertexShader = `uniform float uHull;\nuniform float uHullPx;\n${sh.vertexShader}`.replace(
            '#include <project_vertex>',
            `// FLIP_SIDED is defined for BackSide materials and negates
// transformedNormal — un-negate or the clip push shrinks the shell
// INTO the body instead of ringing it.
#if defined(USE_SKINNING) || defined(USE_ENVMAP)
vec3 hullObjN = objectNormal; vec3 hullViewN = -transformedNormal;
#else
vec3 hullObjN = normal; vec3 hullViewN = normalize(normalMatrix * normal);
#endif
transformed += normalize(hullObjN) * uHull;
#include <project_vertex>
// World-space nudge alone is subpixel past ~20m — expand again in clip
// space along the VIEW-space normal for a constant ~2px rim at range.
vec4 hullN = projectionMatrix * vec4(hullViewN, 0.0);
gl_Position.xy += normalize(hullN.xy + vec2(1e-6)) * uHullPx * sqrt(max(gl_Position.w, 0.25));`);
        };
      }
      // Clone nodes, not geometry: each hull shares the source's
      // geometry + skeleton, only the material differs.
      for (const sk of this.skinnedMeshes) {
        // Same split-normal crack as the gun: plate hard edges carry
        // divergent per-face normals, so the clip push shreds the ring.
        // Weld a hull-only copy carrying the SKIN attributes (position
        // alone won't merge uv/normal splits) — verts with different
        // bone weights stay split, which is correct for animation.
        let hgeo: THREE.BufferGeometry = sk.geometry;
        const pos = sk.geometry.attributes.position;
        if (pos && sk.geometry.attributes.skinIndex) {
          const skin = new THREE.BufferGeometry();
          skin.setAttribute('position', pos);
          skin.setAttribute('skinIndex', sk.geometry.attributes.skinIndex);
          skin.setAttribute('skinWeight', sk.geometry.attributes.skinWeight);
          const w = mergeVertices(skin);
          if (w.index) {w.computeVertexNormals(); hgeo = w;}
        }
        const h = new THREE.SkinnedMesh(hgeo, this.hullMat);
        h.bind(sk.skeleton, sk.bindMatrix);
        // Non-identity source node transforms would offset the hull.
        h.position.copy(sk.position); h.quaternion.copy(sk.quaternion); h.scale.copy(sk.scale);
        h.renderOrder = 2;
        h.frustumCulled = false;
        (sk.parent ?? this.model).add(h);
        this.hulls.push(h);
      }
      this.rebuildGunHulls(); // the held prop is part of the silhouette
    }
    if (this.hullMat && hex !== null) {this.hullMat.color.setHex(hex);}
    for (const h of this.hulls) {h.visible = hex !== null;}
    for (const h of this.gunHulls) {h.visible = hex !== null;}
  }

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
