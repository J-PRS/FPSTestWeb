// Progressive bone LOD for far remotes: distal bones are every bone NOT
// on an ancestor chain of a key bone (aim chain, grip, steady dampers,
// IK feet). Their subtrees — fingers, toes, rig end-markers, twist
// helpers — carry ~60% of the traversal nobody reads past ~60m, so
// freezing them (matrixAutoUpdate off) cuts that work while the core
// pose still animates. Engine rule applied: never freeze a bone an
// essential bone hangs under — ancestors of key bones stay live by
// construction.
//
// Frozen clips also shed their distal-bone TRACKS so the mixer skips
// evaluation entirely rather than writing values nobody reads; frozen
// bones hold their pose, core tracks stay bit-identical.
import * as THREE from 'three';
import { normBone } from './playerClips.js';

// Primary-motion bones are never expendable — the ancestor-of-keys rule
// alone lets whole legs/arms lock mid-stride on rigs with no hand/foot
// key bones (polyart froze at bind pose → T-posed statue at distance).
const LIMB_BONES =
  /thigh|shin|calf|foot|leg|upperarm|forearm|collar|shoulder|clavicle|pelvis|hips|spine|ribcage|chest|neck|head|hand|palm|arm|toetip/;
const HELPER_BONES =
  /fing|digit|thumb|lash|brow|eye|jaw|tongue|twist|roll|_end|end$|marker|prop|magazine|trigger|pad|blade|belt|extra|proxy|pole|ik/;

export class PlayerDistal {
  private bones: THREE.Bone[] = [];
  private distalBones: THREE.Bone[] = [];
  private distalNameSet = new Set<string>();
  private farActions = new Map<THREE.AnimationAction, THREE.AnimationAction>();
  frozen = false;

  captureBone(b: THREE.Bone): void {
    this.bones.push(b);
  }

  /** Offscreen remotes skip the mixer entirely, so their bones are
   *  static — freezing matrixAutoUpdate drops the whole rig out of
   *  updateMatrixWorld (~40 of ~700 bone nodes walked per frame). */
  setBonesFrozen(frozen: boolean): void {
    for (const b of this.bones) {
      b.matrixAutoUpdate = !frozen;
      if (frozen) {b.updateMatrix();}
    }
  }

  /** The action playAnimation should run — the track-filtered variant
   *  while frozen, the base otherwise. */
  action(base: THREE.AnimationAction, mixer: THREE.AnimationMixer): THREE.AnimationAction {
    return this.frozen ? this.farAction(base, mixer) : base;
  }

  /** Called after the model's bone census — keys are the aim chain,
   *  grip and steady bones the pose controller says must stay live. */
  compute(keys: (THREE.Object3D | undefined)[], model: THREE.Object3D | null): void {
    const essential = new Set<THREE.Object3D>();
    for (const k of keys) {
      for (let o = k; o && o !== model; o = o.parent!) {essential.add(o);}
    }
    this.distalBones = this.bones.filter((b): boolean => {
      if (essential.has(b)) {return false;}
      const nb = normBone(b.name);
      return HELPER_BONES.test(nb) || !LIMB_BONES.test(nb);
    });
    this.distalNameSet = new Set(this.distalBones.map((b): string => normBone(b.name)));
  }

  /** Clip variant with every distal-bone track removed. */
  private farAction(action: THREE.AnimationAction, mixer: THREE.AnimationMixer): THREE.AnimationAction {
    let a = this.farActions.get(action);
    if (!a) {
      const src = action.getClip();
      const tracks = src.tracks.filter((t): boolean =>
        !this.distalNameSet.has(normBone(t.name.slice(0, t.name.indexOf('.')))));
      a = mixer.clipAction(new THREE.AnimationClip(`${src.name}.far`, src.duration, tracks));
      this.farActions.set(action, a);
    }
    return a;
  }

  private baseAction(a: THREE.AnimationAction): THREE.AnimationAction {
    for (const [base, far] of this.farActions) {if (far === a) {return base;}}
    return a;
  }

  /** Toggle the freeze. Returns the action that should become current —
   *  the caller swaps currentAction to it (same phase, the core pose
   *  doesn't pop; distal bones simply hold or resume where they were). */
  setFrozen(frozen: boolean, current: { action: THREE.AnimationAction | null }, mixer: THREE.AnimationMixer): THREE.AnimationAction | null {
    const was = this.frozen;
    this.frozen = frozen;
    for (const b of this.distalBones) {
      b.matrixAutoUpdate = !frozen;
      if (frozen) {b.updateMatrix();}
    }
    if (was === frozen || !current.action) {return null;}
    const t = current.action.time;
    const cur = current.action;
    const next = frozen ? this.farAction(cur, mixer) : this.baseAction(cur);
    cur.stop();
    next.reset();
    next.time = t % next.getClip().duration;
    next.timeScale = cur.timeScale;
    next.setLoop(cur.loop, cur.repetitions);
    next.clampWhenFinished = cur.clampWhenFinished;
    next.setEffectiveWeight(cur.getEffectiveWeight() || 1);
    next.play();
    return next;
  }
}
