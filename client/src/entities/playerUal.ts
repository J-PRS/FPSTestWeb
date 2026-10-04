import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ChildLogger } from '../core/Logger.js';
import { UAL_BONE_MAP, UAL2_BONE_MAP, MANNEQUIN_UAL2_BONE_MAP, KEVDEV_BONE_MAP, MANNEQUIN_KEVDEV_BONE_MAP, VEXA_KEVDEV_BONE_MAP, CYBER_KEVDEV_BONE_MAP, CYBER_MANNEQUIN_BONE_MAP, POLYART_KEVDEV_BONE_MAP, POLYART_UAL2_BONE_MAP, RIG_MANIFEST, CLASS_BODY_SPEC, ONESHOT_CLIPS, normBone } from './playerClips.js';
import { stripHipXZ, dampenSway, computeRootMotionNodes, isLayeredClip, AIM_BONE_MASK, SWAY_BONES } from './playerClipSurgery.js';
import { HOLD_QUATS, holdChains } from './playerPose.js';

const logger = new ChildLogger('PlayerUal');

/** One source animation pack: the rig's own bone map, its DEF-/UE-style
 *  name prefix, and which bone is the hip for translation scaling. */
interface UalSpec { id: string; url: string; boneMap: Record<string, string>; mannMap?: Record<string, string>; mapByVariant?: Record<string, Record<string, string>>; prefix: string; hip: string; exclude?: RegExp }
interface UalSource {
  spec: UalSpec; src: THREE.Object3D; srcBones: THREE.Object3D[];
  srcByNorm: Map<string, THREE.Object3D>; srcHip: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

// Two-stage global cache: the GLB fetch/parse is shared, then the FIRST
// live model to need clips pays the resample bake (retarget needs a
// target skeleton — result is name-keyed data identical for every
// instance). Two stages because a bake bound to one disposed model must
// not poison the cache for everyone else.
let ualSource: Promise<UalSource[]> | null = null;
// Baked clips are keyed per variant — a retarget's output tracks are
// name-bound to the skeleton they were baked against, so robot clips
// can't serve the mannequin's DEF-* bones.
const bakedByVariant = new Map<string, Map<string, THREE.AnimationClip>>();

/** Headless hook — _tools/animbake passes a disk-backed loader so the
 *  same pipeline runs offline (default = GLTFLoader over fetch). */
export interface UalBakeEnv {
  loadGltf?: (url: string) => Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>;
}

const SPECS: UalSpec[] = [
  // UAL1 rides a DEF-* Rigify rig; UAL2 (slide/ninja-jump) uses UE-style
  // names. Each bakes with its own bone map; clips merge into one cache.
  // Robot-only: the mannequin ships its UAL set natively inside its GLB
  // and its UAL2 retarget bakes limb-axis artifacts (UE vs Rigify bone
  // conventions) — variants filter keeps it off that path entirely.
  { id: 'ual1', url: '/assets/models/robot-anims.glb', boneMap: UAL_BONE_MAP, prefix: 'def', hip: 'defhips' },
  { id: 'ual2', url: '/assets/models/robot-anims2.glb', boneMap: UAL2_BONE_MAP, prefix: '', hip: 'pelvis', exclude: /^(armature|mannequin|root)$/i,
    mapByVariant: { polyart: POLYART_UAL2_BONE_MAP } },
  // KevDev directional locomotion (8-dir walk/run, 5-dir sprint) — the
  // strafe/backpedal clips neither UAL free tier ships. B-* rig; the
  // root/proxy/finger bones are collected but unmapped, so they cost a
  // traverse pass and nothing else.
  { id: 'kevdev', url: '/assets/models/kevdev-anims.glb', boneMap: KEVDEV_BONE_MAP, mannMap: MANNEQUIN_KEVDEV_BONE_MAP,
    prefix: 'b', hip: 'bhips', exclude: /^(broot|bspineproxy|bhandprop|bjaw|btoe)/i,
    // Vexa's Base_Human* chain is semantically the kevdev skeleton — she
    // ships no locomotion of her own, so run/walk comes from this bake.
    // Cybersoldier's rig maps the same way (UE-style bone names).
    mapByVariant: { vexa: VEXA_KEVDEV_BONE_MAP, cybersoldier: CYBER_KEVDEV_BONE_MAP, polyart: POLYART_KEVDEV_BONE_MAP } },
  // CyberSoldier ships zero clips of his own — kevdev covers locomotion
  // only, so the mannequin's native UAL set (idle/jump/death/hit/shoot)
  // retargets onto his rig to fill every non-locomotion state. Cyber-only
  // spec: the mannequin already has these clips natively and other rigs
  // don't share his bone names.
  { id: 'mannequin', url: '/assets/models/mannequin.glb', boneMap: CYBER_MANNEQUIN_BONE_MAP,
    prefix: 'def', hip: 'defhips' },
];

// KevDev directional clips turn the hips toward travel (authored "run
// that way" — measured: Left -100°, Right +87°, Back +168° on the hip's
// world yaw). Unwinding ONLY the hips re-faces the whole torso at once:
// the authored spine lean-twist and neck counter-turn are exactly the
// strafe-lean flavor we want to keep — twisting spine001 by the same
// delta was the earlier inverted-chest bug.
const DIRCLIP_YAW: Record<string, number> = {
  Forward: 0, ForwardRight: Math.PI / 4, Right: Math.PI / 2,
  BackwardRight: Math.PI * 3 / 4, Backward: Math.PI,
  BackwardLeft: -Math.PI * 3 / 4, Left: -Math.PI / 2, ForwardLeft: -Math.PI / 4,
};

const _unwindKey = new THREE.Quaternion();
const _unwindFix = new THREE.Quaternion();
const _unwindParent = new THREE.Quaternion();
const _unwindM = new THREE.Matrix4();
const _yAxis = new THREE.Vector3(0, 1, 0);
const UNWIND_NODES = new Set(['defhips', 'hips', 'pelvis', 'bhips']);

/** Undo the hip-level body-turn on a directional clip: premultiply hip
 *  quaternion keys by Ry(-sectorYaw) mapped into the hip's PARENT frame
 *  (keys are local — a raw world-axis premultiply hits the armature's
 *  rotated frame and lies the body flat). Runs once inside the bake;
 *  the clip cache is shared across model instances. */
function unwindDirYaw(clip: THREE.AnimationClip, model: THREE.Object3D, target: THREE.SkinnedMesh): void {
  const m = clip.name.match(/_(Forward|Backward|Left|Right|ForwardLeft|ForwardRight|BackwardLeft|BackwardRight)$/);
  const yaw = m ? DIRCLIP_YAW[m[1]!] : undefined;
  if (yaw === undefined || yaw === 0) return;
  const world = _unwindFix.setFromAxisAngle(_yAxis, -yaw);
  const parentQ = new Map<string, THREE.Quaternion>();
  for (const tr of clip.tracks) {
    if (!tr.name.endsWith('.quaternion')) continue;
    const node = tr.name.slice(0, tr.name.indexOf('.'));
    if (!UNWIND_NODES.has(normBone(node))) continue;
    let fixLocal = parentQ.get(node);
    if (!fixLocal) {
      const bone = target.skeleton.getBoneByName(node);
      if (!bone?.parent) continue;
      // Model-relative parent quat — same convention as the torso
      // rest-pose offsets (model.matrixWorld stripped so its π yaw
      // doesn't bake into the correction).
      _unwindParent.setFromRotationMatrix(
        _unwindM.copy(model.matrixWorld).invert().multiply(bone.parent.matrixWorld));
      fixLocal = _unwindParent.clone().invert().multiply(world).multiply(_unwindParent);
      parentQ.set(node, fixLocal);
    }
    const v = tr.values;
    for (let i = 0; i < v.length; i += 4) {
      _unwindKey.set(v[i], v[i + 1], v[i + 2], v[i + 3]).premultiply(fixLocal);
      v[i] = _unwindKey.x; v[i + 1] = _unwindKey.y; v[i + 2] = _unwindKey.z; v[i + 3] = _unwindKey.w;
    }
  }
}

function loadSources(env?: UalBakeEnv): Promise<UalSource[]> {
  ualSource ??= (async () => {
    const sources: UalSource[] = [];
    for (const spec of SPECS) {
      const gltf = env?.loadGltf
        ? await env.loadGltf(spec.url)
        : await new GLTFLoader().loadAsync(spec.url);
      const src = gltf.scene;
      src.updateMatrixWorld(true);
      // No meshes in the trimmed GLBs — the joints arrive as plain
      // Object3Ds. retargetClip only needs .skeleton.bones to iterate.
      const srcBones: THREE.Object3D[] = [];
      src.traverse(o => {
        const n = normBone(o.name);
        if (n.startsWith(spec.prefix) && (!spec.exclude || !spec.exclude.test(o.name))) srcBones.push(o);
      });
      (src as unknown as { skeleton: object }).skeleton = {
        bones: srcBones,
        // PropertyBinding.findNode resolves track node names through this.
        getBoneByName(n: string) { return srcBones.find(b => b.name === n); },
      };
      const srcByNorm = new Map(srcBones.map(b => [normBone(b.name), b]));
      const srcHip = srcByNorm.get(spec.hip);
      if (!srcHip) throw new Error(`UAL rig missing hip ${spec.hip} in ${spec.url}`);
      sources.push({ spec, src, srcBones, srcByNorm, srcHip, clips: gltf.animations });
    }
    return sources;
  })().catch(e => {
    logger.warn('UAL anims failed to load — native clips only', e);
    ualSource = null; // let a later model retry (e.g. transient 404)
    return Promise.reject(e);
  });
  return ualSource;
}

/** Retargeted UAL clip table for this model's variant — baked once per
 *  variant, name-keyed 'UAL_*'. Resolves to the shared cache on repeat
 *  calls; rejects only if the source GLBs can't load/bake. */
export async function bakeUALClips(model: THREE.Object3D, variant: string, env?: UalBakeEnv): Promise<Map<string, THREE.AnimationClip>> {
  const sources = await loadSources(env);
  const cached = bakedByVariant.get(variant);
  if (cached) return cached;

  // Target: this model's skinned mesh + its full skeleton. Multi-skin
  // GLBs carry a duplicate skeleton per mesh (class_heavy's head/body/
  // backpack/arm/leg) — GLTFLoader dedupes their joint names with `_N`
  // suffixes. Retarget onto the UNSUFFIXED skeleton: baked track names
  // fan out to the sibling sets below, so every skin animates instead
  // of one mesh following clips while the rest hold bind pose.
  let target: THREE.SkinnedMesh | undefined;
  let firstSkin: THREE.SkinnedMesh | undefined;
  model.traverse(o => {
    if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return;
    const sm = o as THREE.SkinnedMesh;
    firstSkin ??= sm;
    if (!target && !/_\d+$/.test(sm.skeleton.bones[0]?.name ?? '')) target = sm;
  });
  target ??= firstSkin;
  if (!target) throw new Error('no skinned mesh to retarget onto');
  model.updateMatrixWorld(true);

  // Snapshot the rest pose once — every bakeSource reads the hip's local
  // transform as its bind reference and retargetClip leaves the skeleton
  // at its last evaluated frame, so a second source would bake off the
  // first's residue and drag the mesh ~100 units out of the body.
  const rest = target.skeleton.bones.map(b => ({
    b, p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone(),
  }));
  const restoreRest = () => {
    for (const r of rest) { r.b.position.copy(r.p); r.b.quaternion.copy(r.q); r.b.scale.copy(r.s); }
    model.updateMatrixWorld(true);
  };

  const t0 = performance.now();
  const baked = new Map<string, THREE.AnimationClip>();
  // Which sources feed this rig lives on its manifest row — a new
  // variant never edits this list, only its RIG_MANIFEST entry.
  const want = new Set(RIG_MANIFEST[variant]?.sources ?? []);
  for (const s of sources) {
    if (!want.has(s.spec.id)) continue;
    restoreRest();
    for (const [name, clip] of bakeSource(s, target, model, variant)) baked.set(name, clip);
  }
  // Leave the skeleton at its authored rest, not the last baked frame.
  restoreRest();

  // Clip surgery rides inside the bake so offline-baked GLBs (_tools/
  // animbake) ship byte-identical results — runtime retarget output and
  // shipped clips must not diverge. Every variant's clips get the hip
  // XZ strip (entity owns world position); mannequin's layered clips
  // additionally yield their arm tracks to the aim layer.
  const roots = computeRootMotionNodes(model);
  for (const [name, clip] of baked) {
    stripHipXZ(clip, roots);
    if (variant === 'mannequin' && isLayeredClip(name)) {
      clip.tracks = clip.tracks.filter(t =>
        !AIM_BONE_MASK.has(normBone(t.name.slice(0, t.name.indexOf('.')))));
      dampenSway(clip, SWAY_BONES);
    }
  }
  if (bakeArmHold(baked, target, variant)) {
    // Marks the pack so PlayerModel skips the runtime holdBones compose —
    // pre-bake anims files simply lack the marker and keep the old path.
    baked.set('__holdbake1', new THREE.AnimationClip('__holdbake1', 0.01, []));
  }
  logger.debug(`UAL retarget baked ${baked.size} clips for ${variant} in ${(performance.now() - t0).toFixed(0)}ms`);
  bakedByVariant.set(variant, baked);
  return baked;
}

/** Bake the hip-fire grip into arm-chain tracks — the same bind×off
 *  compose PoseControl used to run every frame post-mixer. Only rigs
 *  without a native anims table take it (same predicate as
 *  wantHoldPose); mannequin/robot limb names just don't resolve into
 *  the chains, so the predicate's second half is data-driven.
 *  Oneshot/death clips keep authored arm tracks — the runtime
 *  suppression rule (oneshotOwnsArms) hands them the arms either way.
 *  Skeleton is at authored rest when this runs (post-restoreRest), so
 *  bone.quaternion IS the bind local. Returns whether it baked. */
function bakeArmHold(baked: Map<string, THREE.AnimationClip>, target: THREE.SkinnedMesh, variant: string): boolean {
  if (CLASS_BODY_SPEC[variant]?.anims) return false;
  const chains = holdChains();
  const quats = HOLD_QUATS[variant] ?? HOLD_QUATS['cybersoldier']!;
  const roleOf = new Map<string, number>();
  for (const b of target.skeleton.bones) {
    const nb = normBone(b.name);
    for (let r = 0; r < chains.length; r++) {
      if (chains[r]!.has(nb)) { roleOf.set(b.name, r); break; }
    }
  }
  if (!roleOf.size) return false;
  const _hold = new THREE.Quaternion();
  const _off = new THREE.Quaternion();
  for (const [name, clip] of baked) {
    // Aim poses feed the masked aim layer — flattening them would pin the
    // pitch blend to a single constant frame.
    if (ONESHOT_CLIPS.has(name) || name === 'UAL_Death01' || name.includes('Aim_')) continue;
    for (const tr of clip.tracks) {
      if (!tr.name.endsWith('.quaternion')) continue;
      const role = roleOf.get(tr.name.slice(0, tr.name.indexOf('.')));
      if (role === undefined) continue;
      const bone = target.skeleton.getBoneByName(tr.name.slice(0, tr.name.indexOf('.')));
      if (!bone) continue;
      _hold.copy(bone.quaternion).multiply(_off.set(...quats[role]!));
      tr.times = new Float32Array([0, clip.duration]);
      tr.values = new Float32Array([_hold.x, _hold.y, _hold.z, _hold.w, _hold.x, _hold.y, _hold.z, _hold.w]);
    }
  }
  return true;
}

// Offline-baked clip packs the client prefers when present — ships the
// whole retarget ahead of time so the async bake can't flash a T-pose
// (and saves ~100-300ms of main-thread resample on load). Missing file
// resolves null → runtime bake fallback keeps dev rigs working.
const bakedFileByVariant = new Map<string, Promise<Map<string, THREE.AnimationClip> | null>>();

export function loadBakedUALClips(variant: string): Promise<Map<string, THREE.AnimationClip> | null> {
  let p = bakedFileByVariant.get(variant);
  if (!p) {
    p = new GLTFLoader().loadAsync(`/assets/anims/${variant}.glb`)
      .then(gltf => gltf.animations.length ? new Map(gltf.animations.map(c => [c.name, c])) : null)
      .catch(() => null);
    bakedFileByVariant.set(variant, p);
  }
  return p;
}

/** Bake one source pack's clips onto the target skeleton — names map, the
 *  torso rest-pose correction, hip scale, then retargetClip per clip. */
function bakeSource(
  { spec, src, srcBones, srcByNorm, srcHip, clips }: UalSource,
  target: THREE.SkinnedMesh, model: THREE.Object3D, variant: string,
): Map<string, THREE.AnimationClip> {
  // names: target bone name → source bone name. The mannequin maps its
  // DEF-* bones onto the UE-style UAL2 rig instead of the robot's
  // Rigify-side table.
  const boneMap = spec.mapByVariant?.[variant]
    ?? (variant === 'mannequin' ? (spec.mannMap ?? MANNEQUIN_UAL2_BONE_MAP) : spec.boneMap);
  const names: Record<string, string> = {};
  for (const b of target.skeleton.bones) {
    // GLTFLoader dedupes repeated node names with a `_N` suffix —
    // multi-skin GLBs like class_heavy list the same joints once per
    // skin, so every bone past the first skin arrives renamed.
    const want = boneMap[b.name] ?? boneMap[b.name.replace(/_\d+$/, '')];
    const hit = want && srcByNorm.get(spec.prefix + want);
    if (hit) names[b.name] = hit.name;
  }

  // Rest-pose correction — the load-bearing trick for mixed rigs.
  // retarget copies the SOURCE bone's world rotation onto the target bone
  // each frame, so any bind-pose difference (mannequin T-pose vs robot
  // rest, differing bone axis conventions) bakes a constant tilt into
  // every clip — the 'Jump_Loop face-down' artifact.
  // localOffsets[b] = srcRest⁻¹ × tgtRest makes rest→rest and turns the
  // animation into a DELTA applied on the robot's own skeleton.
  const localOffsets: Record<string, THREE.Matrix4> = {};
  const _m1 = new THREE.Matrix4();
  const qs = new THREE.Quaternion();
  const qt = new THREE.Quaternion();
  for (const [tName, sName] of Object.entries(names)) {
    // Limb bones share the Blender Y-along-bone convention, so the absolute
    // world-rotation copy is already correct for them — an offset would
    // convert raises into tiny rest-relative deltas and flatten them. The
    // TORSO chain (hips/abdomen/torso/neck/head) is different: the
    // mannequin's spine rest pose leans differently than the chibi robot's,
    // and absolute copy bakes a constant forward hunch into every clip.
    // Delta-map the torso, keep limbs absolute.
    const TORSO = variant === 'vexa'
      ? /^Base_Human(Pelvis|Spine1|Ribcage|Neck|Head)$/
      : (variant === 'cybersoldier' || variant === 'polyart')
      ? /^(Hips|Spine|Chest|Neck|Head)$/
      : variant === 'mannequin'
      ? /^DEF-(hips|spine001|spine003|neck|head)$/
      : /^(Hips|Abdomen|Torso_1|Neck|Head)$/;
    if (!TORSO.test(tName.replace(/_\d+$/, ''))) continue;
    const tb = target.skeleton.getBoneByName(tName);
    const sb = srcBones.find(b => b.name === sName);
    if (!tb || !sb) continue;
    sb.getWorldQuaternion(qs).invert();
    // Rest quat in SKELETON space — retarget runs with
    // target.matrixWorld = identity, so the model group's own π yaw must
    // be stripped, else it gets baked into every frame twice.
    qt.setFromRotationMatrix(_m1.copy(model.matrixWorld).invert().multiply(tb.matrixWorld));
    localOffsets[tName] = new THREE.Matrix4().makeRotationFromQuaternion(qs.clone().multiply(qt));
  }

  // Hip translation scale: retargetClip writes the source hip's WORLD
  // position (in model space) multiplied by this scalar, so the ratio
  // must be world-vs-world. Local-position lengths lie on rigs whose
  // armature carries a different axis convention — the cybersoldier's
  // hip sits ~25 units down a rotated frame, and a local ratio lifted
  // his body ~7m off his capsule.
  const tgtHip = target.skeleton.bones.find(b => names[b.name] === srcHip.name);
  const srcHipWorld = new THREE.Vector3();
  srcHip.getWorldPosition(srcHipWorld);
  const tgtHipWorld = new THREE.Vector3();
  if (tgtHip) tgtHipWorld.setFromMatrixPosition(
    _m1.copy(model.matrixWorld).invert().multiply(tgtHip.matrixWorld));
  const scale = tgtHip && srcHipWorld.lengthSq() > 0
    ? tgtHipWorld.length() / srcHipWorld.length() : 1;

  // retargetClip writes the hip's model-SPACE position through the
  // parent's world matrix — on rigs whose armature carries its own
  // convention (cyber's bones sit ~100 units under their Armature node)
  // the baked track drags the whole body that far off the entity.
  // Re-emit it as a delta on the target's own bind hip instead:
  // tgtBind + (srcKey - srcBind) × local-ratio keeps the bounce and the
  // anchor regardless of armature frames.
  const tgtHipBind = tgtHip ? tgtHip.position.clone() : null;
  const srcHipBind = srcHip.position.clone();
  const deltaScale = tgtHipBind && srcHipBind.lengthSq() > 0
    ? tgtHipBind.length() / srcHipBind.length() : 1;
  const fixHip = (rt: THREE.AnimationClip, srcClip: THREE.AnimationClip): void => {
    if (!tgtHip || !tgtHipBind) return;
    // Every skeleton copy's hip needs the same correction — fanned-out
    // tracks arrive named for their own joint variant.
    const srcTr = srcClip.tracks.find(t => t.name === srcHip.name + '.position');
    const interp = srcTr
      ? (srcTr as unknown as { createInterpolant(): { evaluate(t: number): ArrayLike<number> } }).createInterpolant()
      : null;
    const hipNorm = normBone(tgtHip.name);
    for (const hipTr of rt.tracks) {
      if (normBone(hipTr.name.slice(0, hipTr.name.indexOf('.'))) !== hipNorm || !hipTr.name.endsWith('.position')) continue;
      if (!interp) { // no source hip motion — pin to bind
        hipTr.times = hipTr.times.slice(0, 1);
        hipTr.values = new Float32Array([tgtHipBind.x, tgtHipBind.y, tgtHipBind.z]);
        continue;
      }
      const v = hipTr.values, t = hipTr.times;
      for (let i = 0; i < t.length; i++) {
        const s = interp.evaluate(t[i]!);
        v[i * 3] = tgtHipBind.x + (s[0]! - srcHipBind.x) * deltaScale;
        v[i * 3 + 1] = tgtHipBind.y + (s[1]! - srcHipBind.y) * deltaScale;
        v[i * 3 + 2] = tgtHipBind.z + (s[2]! - srcHipBind.z) * deltaScale;
      }
    }
  };

  // Duplicate-skeleton fan-out: for every retargeted bone name, the same
  // keyframes must bind each skin's own joint copy (Hips, Hips_1, ...).
  // base (dedupe-stripped) → all real node names carrying that bone.
  const altNames = new Map<string, string[]>();
  model.traverse(o => {
    if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return;
    for (const b of (o as THREE.SkinnedMesh).skeleton.bones) {
      const base = b.name.replace(/_\d+$/, '');
      const list = altNames.get(base) ?? [];
      if (!list.includes(b.name)) list.push(b.name);
      altNames.set(base, list);
    }
  });
  const fanOut = (rt: THREE.AnimationClip): void => {
    const extra: THREE.KeyframeTrack[] = [];
    for (const t of rt.tracks) {
      const base = t.name.slice(0, t.name.indexOf('.'));
      const alts = altNames.get(base.replace(/_\d+$/, ''));
      if (!alts || alts.length < 2) continue;
      for (const alt of alts) {
        if (alt === base) continue;
        const c = t.clone() as THREE.KeyframeTrack;
        c.name = alt + t.name.slice(base.length);
        extra.push(c);
      }
    }
    rt.tracks.push(...extra);
  };

  const baked = new Map<string, THREE.AnimationClip>();
  for (const clip of clips) {
    const rt = SkeletonUtils.retargetClip(target, src, clip, {
      names,
      hip: srcHip.name,
      scale,
      fps: 30, // keep resampled tracks small — clips ship at 30 anyway
      // Runtime-supported but missing from the .d.ts — per-target-bone
      // offset matrices applied after the source world rotation.
      localOffsets,
    } as Parameters<typeof SkeletonUtils.retargetClip>[3]);
    // retargetClip emits '.bones[Name].prop' tracks that only bind via a
    // skeleton on the mixer root — our mixer roots at the model group, so
    // rewrite to plain 'Name.prop' like native GLTF tracks.
    for (const t of rt.tracks) t.name = t.name.replace(/^\.bones\[(.+)\]\./, '$1.');
    rt.name = 'UAL_' + clip.name;
    unwindDirYaw(rt, model, target);
    fanOut(rt);
    fixHip(rt, clip);
    baked.set(rt.name, rt);
  }
  return baked;
}
