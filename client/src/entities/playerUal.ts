import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ChildLogger } from '../core/Logger.js';
import { UAL_BONE_MAP, UAL2_BONE_MAP, MANNEQUIN_UAL2_BONE_MAP, KEVDEV_BONE_MAP, MANNEQUIN_KEVDEV_BONE_MAP, normBone } from './playerClips.js';

const logger = new ChildLogger('PlayerUal');

/** One source animation pack: the rig's own bone map, its DEF-/UE-style
 *  name prefix, and which bone is the hip for translation scaling. */
interface UalSpec { url: string; boneMap: Record<string, string>; mannMap?: Record<string, string>; prefix: string; hip: string; exclude?: RegExp; variants?: string[] }
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

const SPECS: UalSpec[] = [
  // UAL1 rides a DEF-* Rigify rig; UAL2 (slide/ninja-jump) uses UE-style
  // names. Each bakes with its own bone map; clips merge into one cache.
  // Robot-only: the mannequin ships its UAL set natively inside its GLB
  // and its UAL2 retarget bakes limb-axis artifacts (UE vs Rigify bone
  // conventions) — variants filter keeps it off that path entirely.
  { url: '/assets/models/robot-anims.glb', boneMap: UAL_BONE_MAP, prefix: 'def', hip: 'defhips', variants: ['robot'] },
  { url: '/assets/models/robot-anims2.glb', boneMap: UAL2_BONE_MAP, prefix: '', hip: 'pelvis', exclude: /^(armature|mannequin|root)$/i, variants: ['robot'] },
  // KevDev directional locomotion (8-dir walk/run, 5-dir sprint) — the
  // strafe/backpedal clips neither UAL free tier ships. B-* rig; the
  // root/proxy/finger bones are collected but unmapped, so they cost a
  // traverse pass and nothing else.
  { url: '/assets/models/kevdev-anims.glb', boneMap: KEVDEV_BONE_MAP, mannMap: MANNEQUIN_KEVDEV_BONE_MAP,
    prefix: 'b', hip: 'bhips', exclude: /^(broot|bspineproxy|bhandprop|bjaw|btoe)/i },
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

function loadSources(): Promise<UalSource[]> {
  ualSource ??= (async () => {
    const sources: UalSource[] = [];
    for (const spec of SPECS) {
      const gltf = await new GLTFLoader().loadAsync(spec.url);
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
export async function bakeUALClips(model: THREE.Object3D, variant: string): Promise<Map<string, THREE.AnimationClip>> {
  const sources = await loadSources();
  const cached = bakedByVariant.get(variant);
  if (cached) return cached;

  // Target: this model's skinned mesh + its full skeleton.
  let target: THREE.SkinnedMesh | undefined;
  model.traverse(o => { if (!target && (o as THREE.SkinnedMesh).isSkinnedMesh) target = o as THREE.SkinnedMesh; });
  if (!target) throw new Error('no skinned mesh to retarget onto');
  target.skeleton.pose();
  target.updateMatrixWorld(true);

  const t0 = performance.now();
  const baked = new Map<string, THREE.AnimationClip>();
  for (const s of sources) {
    if (s.spec.variants && !s.spec.variants.includes(variant)) continue;
    for (const [name, clip] of bakeSource(s, target, model, variant)) baked.set(name, clip);
  }
  logger.debug(`UAL retarget baked ${baked.size} clips for ${variant} in ${(performance.now() - t0).toFixed(0)}ms`);
  bakedByVariant.set(variant, baked);
  return baked;
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
  const boneMap = variant === 'mannequin' ? (spec.mannMap ?? MANNEQUIN_UAL2_BONE_MAP) : spec.boneMap;
  const names: Record<string, string> = {};
  for (const b of target.skeleton.bones) {
    const want = boneMap[b.name];
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
    const TORSO = variant === 'mannequin'
      ? /^DEF-(hips|spine001|spine003|neck|head)$/
      : /^(Hips|Abdomen|Torso_1|Neck|Head)$/;
    if (!TORSO.test(tName)) continue;
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

  // Hip translation scale: ratio of rest-pose hip offsets in each rig's
  // local units (mannequin ~1.8m vs chibi robot proportions).
  const tgtHip = target.skeleton.bones.find(b => names[b.name] === srcHip.name);
  const scale = tgtHip && srcHip.position.lengthSq() > 0
    ? tgtHip.position.length() / srcHip.position.length() : 1;

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
    baked.set(rt.name, rt);
  }
  return baked;
}
