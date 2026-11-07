import * as THREE from 'three';

import { ChildLogger } from '../core/Logger.js';

import { ONESHOT_CLIPS, clipCandidates,
  CLASS_BODY_SPEC, CLASS_BODY_DEATH_CLIPS, RIG_MANIFEST,
  normBone, type AnimationState } from './playerClips.js';
import { DIR8, stripHipXZ, dampenSway,
  isLayeredClip, AIM_BONE_MASK, AIM_TORSO_BONES, SWAY_BONES, clampHipY, type LocoDir } from './playerClipSurgery.js';
import { bakeUALClips, loadBakedUALClips } from './playerUal.js';
import type { PoseControl } from './playerPose.js';
import type { PlayerDistal } from './playerDistal.js';
import type { PlayerModelVariant } from './PlayerModel.js';
const logger = new ChildLogger('PlayerModel');


// A missing clip is authored into the GLB — the variant's whole fleet
// misses the same set, so the dedupe is (variant, clip) per session,
// not per model instance. 20 bots of one rig warn once, not 20 times.
const warnedAnimMisses = new Set<string>();

/** The model-side surface PlayerAnim reads — live getters, so the rig
 *  fallback's pose/variant re-assignment stays visible after attach. */
export interface PlayerAnimHost {
  readonly variant: PlayerModelVariant;
  /** Warm/background loads trickle the retarget bake across frames. */
  readonly amortizeBake: boolean;
  readonly model: THREE.Group | null;
  readonly pose: PoseControl;
  readonly distal: PlayerDistal;
  readonly disposed: boolean;
}

/** Mixer + clip table + the anim state machine. PlayerModel owns the
 *  mesh lifecycle; this owns everything that picks, fades, and corrects
 *  AnimationActions on it. */
export class PlayerAnim {
  mixer: THREE.AnimationMixer | null = null;
  readonly animations: Map<string, THREE.AnimationAction> = new Map();
  private _loaded = false;
  // Requests that arrive before the GLB lands — anim state still applies
  // on load instead of warning against an empty map.
  private _queuedAnim: string | null = null;
  currentAction: THREE.AnimationAction | null = null;
  /** Manual weight ramps, stepped in tick(). three's fadeIn/fadeOut
   *  hardcode interpolant endpoints 0→1 / 1→0 regardless of live weight,
   *  so re-firing an action mid-transition snaps its weight to 0 — and a
   *  sub-1 coverage frame mixes toward bind pose (the T-pose flash on
   *  spam). These fades ramp from the action's live weight instead. */
  private fades = new Map<THREE.AnimationAction, {
    from: number; to: number; t: number; dur: number;
  }>();
  currentState: AnimationState = 'idle';
  // Facing-frame locomotion direction, quantized to 8 sectors — feeds the
  // KevDev directional clip table when state is 'walk'/'run'.
  private locoDir: LocoDir = 'F';
  /** True while a dedicated directional clip drives the current action —
   *  callers skip the reverse-playback/strafe-lean fallbacks then. */
  dirClipActive = false;
  currentClipName: string | null = null;
  /** Clip handoff moment — fades.ts ramps for ~0.2s, but the freed
   *  binding's restore-to-bind can still pose bones on the frame after.
   *  The model-offset canary reads posed bounds, so a mid-handoff sample
   *  (corpse pose bleeding into idle) flags as a sink that isn't real. */
  private clipSetAt = 0;
  /** True while a crossfade is live or a clip swap is still settling —
   *  anything that measures posed geometry should skip this window. */
  get transitioning(): boolean {
    return this.fades.size > 0 || performance.now() - this.clipSetAt < 400;
  }
  playingUAL = false;

  constructor(private host: PlayerAnimHost) {}

  private fadeAction(a: THREE.AnimationAction, to: number, dur: number): void {
    a.stopFading();
    this.fades.set(a, {
      from: a.getEffectiveWeight(), to, t: 0,
      dur: Math.max(dur, 1e-4),
    });
  }

  attach(model: THREE.Group): void {
    this.mixer = new THREE.AnimationMixer(model);
  }

  /** Called when the GLB lands: start whatever the last request was
   *  (remotes spawn mid-load and ask for Running/Walking before the
   *  mixer exists). The default goes through the state table — a bare
   *  'Idle' name only exists on knight's rig, other variants resolve
   *  their own idle. */
  markLoaded(): void {
    this._loaded = true;
    if (this._queuedAnim) {this.playAnimation(this._queuedAnim);}
    else {this.forceAnimationState('idle');}
    this._queuedAnim = null;
  }

  // Mannequin/knight clips need their hip XZ root motion stripped — the
  // entity owns world position, and loop clips otherwise translate the
  // mesh out from under the hitbox each cycle. Y stays (the crouch dip).
  registerClip(clip: THREE.AnimationClip, mann: boolean, knight: boolean, rootMotion: Set<string>): void {
    // Garbage-keyframe guard: corrupt exports (class_heavy ships ~1e26
    // translation keys in Shoot_SingleShot_AR and ~1e28 translations AND
    // ~1e32 quats in Reload) throw every vert weighted to the bone past
    // the skybox — the 'model-stretch' glitch. Bounds per track path are
    // wide vs authored ranges (cm rigs top out ~50 pos, quats are unit,
    // bone scales ~1): only bit-rot fails them, and a poisoned track is
    // dropped whole rather than interpolated into the corruption.
    clip.tracks = clip.tracks.filter((t): boolean => {
      // Non-monotonic/NaN key TIMES are poison too — the interpolant
      // binary-searches them, lands off the end, and cubic-extrapolates
      // into km-scale bone fliers (class_heavy: 154 such channels in
      // Shoot_SingleShot_AR). Can't re-sort without re-sorting values.
      const ts = t.times;
      for (let i = 0; i < ts.length; i += 1) {
        if (!Number.isFinite(ts[i]) || (i > 0 && ts[i] < ts[i - 1])) {return false;}
      }
      let cap = 1e4;
if (t.name.endsWith('.quaternion')) {cap = 2;}
else if (t.name.endsWith('.scale')) {cap = 1e3;}
      for (const v of t.values) {if (!Number.isFinite(v) || Math.abs(v) > cap) {return false;}}
      return true;
    });
    // A clip the filter gutted whole still registers — a zero-track
    // action runs, covers nothing, and reads as the bind pose for the
    // clip's duration (polyart's poisoned Shoot/Reload — the "heavy
    // robot T-posing sometimes" report). Skip it so the candidate
    // resolver misses onto a real clip.
    if (clip.tracks.length === 0) {
      const missKey = `${this.host.variant}:gutted:${clip.name}`;
      if (!warnedAnimMisses.has(missKey)) {
        warnedAnimMisses.add(missKey);
        logger.warn(`Clip fully poisoned, skipped: ${clip.name} (variant ${this.host.variant})`);
      }
      return;
    }
    if (mann || knight || CLASS_BODY_SPEC[this.host.variant]) {
      stripHipXZ(clip, rootMotion);
      clampHipY(clip, 0.25, rootMotion);
      if ((mann || RIG_MANIFEST[this.host.variant]?.aimMask) && isLayeredClip(clip.name)) {
        clip.tracks = clip.tracks.filter((t): boolean => {
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
    if (mann) {this.animations.set(`UAL_${  clip.name}`, action);}
  }

  /** Authored clips can bake a facing turn into the hip track — the
   *  polyart pack's Idle_Ducking_ar carries the body at +95° vs the
   *  ~-138° every other clip agrees on, so skiing flipped him toward
   *  the camera. Measure each clip's first key on the animated hip
   *  node, take the set's modal yaw as the rig's forward convention,
   *  and unwind outliers (>~30°) back onto it in the node's parent
   *  frame. */
  alignHipYaw(): void {
    const {model} = this.host;
    if (!model) {return;}
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
        const node = model.getObjectByName(tr.name.slice(0, -'.quaternion'.length));
        if (!node) {continue;}
        if ((node as THREE.Bone).isBone && (!best || this.depthOf(node) < this.depthOf(best.node))) {best = { tr, node };}
        if (!any || this.depthOf(node) < this.depthOf(any.node)) {any = { tr, node };}
      }
      return best ?? any;
    };
    // Yaw must be measured in WORLD space: hips whose parent carries a
    // non-Y rotation (M2M rigs — 'root' bakes Blender's -90° X flip) report
    // a local-quat yaw that diverges nonlinearly from the rendered facing,
    // so corrections land at the wrong magnitude. The world-Y twist of
    // parentQ*key moves 1:1 with the RotY premultiply applied below.
    const wq = new THREE.Quaternion();
    const worldYawOf = (tr: THREE.KeyframeTrack, node: THREE.Object3D): number | null => {
      if (!node.parent) {return null;}
      const parentQ = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(node.parent.matrixWorld));
      const v = tr.values;
      q.set(v[0], v[1], v[2], v[3]);
      wq.copy(parentQ).multiply(q);
      let y = 2 * Math.atan2(wq.y, wq.w);
      while (y > Math.PI) {y -= 2 * Math.PI;}
      while (y < -Math.PI) {y += 2 * Math.PI;}
      return y;
    };
    model.updateMatrixWorld(true);
    const canonical = ((): number | null => {
      // A rig's own authored clips set the convention — a retarget pack
      // can outnumber them (29 baked vs 16 native on class_heavy) and
      // swing the vote to the bake's frame, rotating the native set.
      // When natives exist they alone define canonical; pure-bake rigs
      // fall through to the all-clip vote (and carry clipYawFix anyway).
      const collect = (names: (n: string) => boolean): number | null => {
        const buckets = new Map<number, { sum: number; n: number }>();
        for (const [name, a] of this.animations) {
          if (!names(name)) {continue;}
          const hit = hipTrackOf(a.getClip());
          const y = hit ? worldYawOf(hit.tr, hit.node) : null;
          if (y === null || y === undefined) {continue;}
          const k = Math.round(y / (Math.PI / 18));
          const b = buckets.get(k) ?? { sum: 0, n: 0 };
          b.sum += y;b.n += 1;
          buckets.set(k, b);
        }
        let best = { sum: 0, n: 0 };
        for (const b of buckets.values()) {if (b.n > best.n) {best = b;}}
        return best.n ? best.sum / best.n : null;
      };
      const natives = collect((n): boolean => !n.startsWith('UAL_'));
      return natives ?? collect((): true => true);
    })();
    if (canonical === null) {return;}
    // clipYawFix is an explicit unwind: rigs whose whole retarget set
    // shares the wrong convention (100%-bake rigs) can't derive a target
    // from local-track yaw — the armature parent carries its own offset —
    // so every hip track just gets premultiplied by the fix, no measure.
    const fixRad = RIG_MANIFEST[this.host.variant]?.clipYawFix ?? 0;
    const fixed: string[] = [];
    for (const [, a] of this.animations) {
      const clip = a.getClip();
      const hit = hipTrackOf(clip);
      if (!hit?.node.parent) {continue;}
      const measured = worldYawOf(hit.tr, hit.node);
      let delta = fixRad === 0 ? (measured ?? 0) - canonical : -fixRad;
      if (fixRad === 0 && measured === null) {continue;}
      while (delta > Math.PI) {delta -= 2 * Math.PI;}
      while (delta < -Math.PI) {delta += 2 * Math.PI;}
      if (Math.abs(delta) < 0.5) {continue;}
      // Every hip-skeleton copy carries the same yaw — retarget fan-out
      // ships one track per skin joint, so the fix lands on all of them
      // or the meshes rotate away from each other.
      const hipBase = hit.node.name.replace(/_\d+$/, '');
      for (const tr of clip.tracks) {
        if (!tr.name.endsWith('.quaternion')) {continue;}
        const node = model.getObjectByName(tr.name.slice(0, -'.quaternion'.length));
        if (!node?.parent || node.name.replace(/_\d+$/, '') !== hipBase) {continue;}
        const parentQ = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().copy(model.matrixWorld).invert().multiply(node.parent.matrixWorld));
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
    for (let p = node.parent; p && p !== this.host.model; p = p.parent) {d += 1;}
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
        const missKey = `${this.host.variant}:${name}`;
        if (!warnedAnimMisses.has(missKey)) {
          warnedAnimMisses.add(missKey);
          logger.warn(`Animation not found: ${name} (variant ${this.host.variant})`);
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
    const action = this.host.distal.action(base, this.mixer!);
    // Same clip re-requested (jump↔jet share clips on the class rigs) —
    // refading an already-running action dips its weight through 0 and
    // flashes the bind pose; oneshots still restart since a replay is
    // the point of re-firing them. The isRunning check is the stall
    // guard's lifeline: forceAnimationState re-entering a stopped action
    // must actually restart it or the model stays T-posed forever.
    if (action === this.currentAction && action.isRunning() && !ONESHOT_CLIPS.has(name) && startPhase <= 0) {
      this.clipSetAt = performance.now();
      this.currentClipName = name;
      this.playingUAL = name.startsWith('UAL_');
      return;
    }

    // (no per-clip head bookkeeping — the pitch un-apply in tick() handles
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
    this.clipSetAt = performance.now();
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
    const cands = clipCandidates(this.host.variant, state, this.locoDir);
    for (let i = 0; i < cands.length; i += 1) {
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
  retargetUAL(): void {
    const {model} = this.host;
    if (!model) {return;}
    const adopt = (baked: Map<string, THREE.AnimationClip>): void => {
      if (this.host.disposed || !this.mixer || !this.host.model) {return;}
      // Baked clips arrive fully cooked — hip-XZ strip and the
      // mannequin aim-layer carve are applied at bake time.
      // `__holdbake1` marks packs whose arm tracks already carry the
      // hip-fire grip — the runtime holdBones compose stands down.
      this.host.pose.holdBaked = baked.has('__holdbake1');
      for (const [name, clip] of baked) {
        if (name === '__holdbake1') {continue;}
        this.animations.set(name, this.mixer.clipAction(clip));
      }
      // Baked clips land AFTER the load-time alignHipYaw ran — for
      // retarget-only rigs that pass saw an empty table and did nothing.
      // Re-run so the bake's own hip convention gets canonicalized.
      if (CLASS_BODY_SPEC[this.host.variant]) {this.alignHipYaw();}
      // Aim clips ride inside the retarget pack for rigs like robot —
      // the load-time aim-layer build saw an empty table for them.
      // Robot's aim clips carry pitch in the spine tracks, so his mask
      // includes the torso chain (arm-only sweeps horizontally).
      if ([...baked.keys()].some((n): boolean => n.includes('Aim_')))
        {this.host.pose.buildAimLayer(this.mixer, this.animations, this.host.variant === 'robot');}
      // Re-resolve the current state onto the better clip if one landed —
      // the baked names now sit in the same candidate table the state
      // resolver reads, so let it pick (a bare 'Idle' name doesn't exist
      // on every rig).
      this.forceAnimationState(this.currentState);
    };
    const runtimeBake = (): Promise<void> =>
      bakeUALClips(model, this.host.variant, undefined, this.host.amortizeBake).then(adopt)
        .catch((error): void => { logger.warn(`UAL bake failed for ${  this.host.variant}`, error); });
    // The offline bake (public/assets/anims/<variant>.glb) ships the
    // whole retarget so load never flashes bind pose or burns a
    // resample; missing file → dev rigs still runtime-bake.
    loadBakedUALClips(this.host.variant).then((baked): void => {
      if (baked && baked.size > 0) {adopt(baked);}
      else {runtimeBake();}
    return; }).catch(runtimeBake);
  }

  /** Per-frame: weight fades, the stalled-cover guard, then pose
   *  corrections (aim pitch, hip-fire hold, spine lock, foot IK). */
  tick(dt: number): void {
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
      if (!warnedAnimMisses.has('__stall')) {
        warnedAnimMisses.add('__stall');
        logger.warn(`Anim action stalled in state '${this.currentState}' (${this.currentClipName}) — re-entering`);
      }
      // Re-entering restarts the clip at t=0 - the stalled pose snaps to
      // cycle start = a visible pop every stall. Carry the dead action's
      // cycle fraction onto the re-entered action so recovery is seamless
      // whatever stalled it (PingPong's reverse leg loses direction, but
      // a phase-near pose beats a frame-0 restart).
      const dead = this.currentAction;
      const dur = Math.max(dead.getClip().duration, 1e-6);
      const frac = (dead.time % dur) / dur;
      this.forceAnimationState(this.currentState);
      if (this.currentAction) {this.currentAction.time = frac * this.currentAction.getClip().duration;}
    }
    this.host.pose.update(dt, this.mixer, this.currentAction, this.currentClipName, this.playingUAL, this.host.model ?? undefined, this.currentState);
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.animations.clear();
    this.mixer = null;
    this.currentAction = null;
  }
}
