import * as THREE from 'three';

import { ONESHOT_CLIPS, normBone } from './playerClips.js';
import { AIM_BONE_MASK, AIM_TORSO_BONES } from './playerClipSurgery.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('playerPose');

const X_AXIS = new THREE.Vector3(1, 0, 0);
const _pitchQuat = new THREE.Quaternion();
const _boneWorld = new THREE.Quaternion();
const _rootWorld = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _footW = new THREE.Vector3();
const _footQ = new THREE.Quaternion();
const _footPQ = new THREE.Quaternion();

// Hip-fire grip pose data — shared with the animbake pass in playerUal
// so runtime pose correction and baked clips compose the SAME pose.
// Right-arm grip per bone role — norm-name set + quat offset in
// bone-local space. Solved analytically against the bind pose (target
// world direction per bone's +Y axis → back-converted to a local offset);
// blind euler tuning in bone space produces unpredictable world poses.
export const HOLD_QUATS: Record<string, [number, number, number, number][]> = {
  cybersoldier: [
    [0.3696, 0, 0.082, 0.9256],
    [0.5198, 0, -0.6705, 0.5294],
    [0.5661, 0, -0.4822, 0.6686],
    [-0.208, 0, -0.0373, 0.9774],
    [0.1679, 0, -0.5729, 0.8023],
    [0.092, 0, -0.4257, 0.9002],
  ],
  vexa: [
    [-0.1, 0, -0.8276, 0.5524],
    [0.568, 0, 0.7929, 0.2204],
    [0.7046, 0, -0.0591, 0.7072],
    [0.0822, 0, -0.8304, 0.5511],
    [-0.8729, 0, 0.4465, 0.1968],
    [-0.7144, 0, -0.0469, 0.6982],
  ],
  // Sampled from Fire_2Pistol's aim frame (t≈0.3) — the pack's authored
  // forward two-hand aim, lifted as bind-relative offsets incl. the
  // collarbones (chain roles 6/7) so the pinned pose reproduces the
  // clip's shoulder line too, not just the arm links.
  scifisoldier: [
    [0.0823, -0.0356, 0.5247, 0.8465],
    [0.1031, -0.0087, 0.4354, 0.8943],
    [0.0966, -0.1437, 0.0193, 0.9847],
    [-0.0159, 0.053, 0.6019, 0.7967],
    [-0.0268, -0.0488, 0.1923, 0.9798],
    [-0.1916, 0.1808, 0.0394, 0.9639],
    [0, 0, 0.123, 0.9924],
    [0, 0, 0.0586, 0.9983],
  ],
};

let _holdChains: Set<string>[] | null = null;
export function holdChains(): Set<string>[] {
  if (!_holdChains) {
    _holdChains = [
      new Set(['upperarmr', 'basehumanrupperarm', 'basehumanrupperarm1', 'rigarmright1']),
      new Set(['lowerarmr', 'forearmr', 'basehumanrforearm1', 'basehumanrforearm', 'rigarmright2']),
      new Set(['handr', 'palm2r', 'fistr', 'basehumanrpalm', 'rigarmright3']),
      // Left arm comes across to the foregrip — without it the retargeted
      // clip tracks flail the free arm every frame.
      new Set(['upperarml', 'basehumanlupperarm', 'basehumanlupperarm1', 'rigarmleft1']),
      new Set(['lowerarml', 'forearml', 'basehumanlforearm1', 'basehumanlforearm', 'rigarmleft2']),
      new Set(['handl', 'palm2l', 'fistl', 'basehumanlpalm', 'rigarmleft3']),
      // Collarbones — the clip still animates these, dragging the pinned
      // arm chain's root (scifi's hold ended up muzzle-sideways).
      new Set(['rigarmrightcollarbone']),
      new Set(['rigarmleftcollarbone']),
    ];
  }
  return _holdChains;
}

/** True while a full-body oneshot (shoot/hit/death) actually OWNS the
 *  arms: during fadeOut the clip is still isRunning but its weight is
 *  decaying — suppressing on isRunning alone left the arm chain un-driven
 *  for ~200ms after every shot (arms drifted toward bind pose = the
 *  "opens hands, almost T-pose" on each trigger pull). Death clamps at
 *  full weight so its suppression still holds forever. */
export function oneshotOwnsArms(action: THREE.AnimationAction | null, clipName: string | null): boolean {
  return action != null && action.isRunning() && action.getEffectiveWeight() > 0.5 &&
    clipName != null && (ONESHOT_CLIPS.has(clipName) || clipName === 'UAL_Death01');
}

/** Post-mixer pose corrections: procedural aim pitch, hip-fire hold on
 *  socket-gun rigs, spine lock while firing, IK foot snap. Each layer
 *  un-applies its last write before the mixer runs so nothing
 *  accumulates on a stale posed value. */
export class PoseControl {
  // Aim-pitch bones: quaternion pitch stacked on top of the animated pose.
  private aimBones: { bone: THREE.Object3D; factor: number; last: THREE.Quaternion }[] = [];
  aimPitch = 0;
  // Applied pitch lags the input — local mouse flicks and 20Hz wire
  // steps otherwise whip the head at frame/input rate. ~12/s chases
  // real aim while smoothing single-frame jumps.
  private aimPitchSm = 0;
  // Whether `last` quats currently hold applied pose (pitch or grip) —
  // the un-apply pass skips entirely when flat, which is most frames on
  // idle bodies.
  private poseApplied = false;
  // Socket-gun rigs: canned right-arm grip pose stacked post-mixer — their
  // retargeted clips flatten the arm raise (rig axis mismatch), so the arm
  // is posed procedurally to meet the fixed gun socket.
  private holdBones: { bone: THREE.Object3D; role: number; off: THREE.Quaternion; last: THREE.Quaternion; bind: THREE.Quaternion }[] = [];
  private holdQuats: [number, number, number, number][];
  wantHoldPose = false;
  /** Hold the grip only in idle — rigs with good retargeted arm tracks
   *  keep them everywhere else; idle just swaps aimed for low-carry. */
  holdIdle = false;
  /** Clips already carry the grip pose in their arm tracks (the
   *  `__holdbake1` marker on the adopted clip table) — the runtime
   *  compose is for rigs on pre-bake files or native-only clip sets. */
  holdBaked = false;
  /** armedHold rigs keep the grip through Fire_* oneshots — hip-fire
   *  doesn't lower the weapon to shoot. Hit/death still own the arms. */
  holdShoots = false;
  private holdW = 0;

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
  /** Aim-pin rigs (mannequin): even with arm/torso quat tracks yielded to
   *  the aim layer, ground loco still sways the upper body enough to drag
   *  the gripped weapon toward center. Pin the masked bones to their last
   *  non-loco pose while walk/run plays — same hold as idle/airborne —
   *  while legs and hip position bob keep animating underneath. */
  lockLocoTorso = false;
  private locoBones: { bone: THREE.Object3D; last: THREE.Quaternion; cached: boolean }[] = [];
  private locoW = 0;
  // 0→1 ramp while recently fired — drives the spine lock.
  private armedT = 0;
  private armed = 0;
  /** The lock exists for UAL-retargeted clips that carry stride roll into
   *  the torso; a native shoot clip poses its own torso consistently, and
   *  locking it to bind pivots the arm chain (and the mounted gun) around
   *  the torso/clip stance mismatch — the sideways gun swing on fire. */
  wantSpineLock = true;
  // Foot bones are IK targets detached from the leg chain — retargeted
  // clips leave them frozen mid-air. When a UAL clip plays, snap each foot
  // to its shin tip (the *_end leaf node follows the skinned leg).
  private footSnaps: { foot: THREE.Object3D; shin: THREE.Object3D; tip: THREE.Object3D }[] = [];

  constructor(variant = 'cybersoldier') {
    holdChains();
    this.holdQuats = HOLD_QUATS[variant] ?? HOLD_QUATS['cybersoldier']!;
  }

  /** Bones the far-LOD swap must keep real (freeze-proof) — pose control
   *  writes into them every frame. */
  keyBones(): THREE.Object3D[] {
    return [
      ...this.aimBones.map((b): THREE.Object3D<THREE.Object3DEventMap> => b.bone),
      ...this.steadyBones.map((b): THREE.Object3D<THREE.Object3DEventMap> => b.bone),
      ...this.footSnaps.flatMap((f): THREE.Object3D<THREE.Object3DEventMap>[] => [f.foot, f.shin, f.tip]),
    ];
  }

  get aimBoneCount(): number { return this.aimBones.length; }

  aimBoneNames(): string {
    return this.aimBones.map((b): string => b.bone.name).join(', ') || 'NONE';
  }

  /** Live-tune the hold pose (posedump iteration loop) — deg per role. */
  debugSetHold(upper: [number, number, number], lower: [number, number, number], hand: [number, number, number], lUpper: [number, number, number] = upper.map((v): number => -v) as [number, number, number], lLower: [number, number, number] = lower, lHand: [number, number, number] = hand): void {
    const rads = [upper, lower, hand, lUpper, lLower, lHand].map((e): THREE.Quaternion =>
      new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0] * Math.PI / 180, e[1] * Math.PI / 180, e[2] * Math.PI / 180)));
    for (const hb of this.holdBones) {hb.off.copy(rads[hb.role] ?? new THREE.Quaternion());}
  }

  // Collects the bones this controller drives. nb = normBone(child.name).
  captureBone(child: THREE.Object3D, nb: string): void {
    if (child.name === 'Head' || nb === 'defhead' || nb === 'head' || nb === 'righead') {
      this.aimBones.push({ bone: child, factor: 0.4, last: new THREE.Quaternion() });
    } else if (child.name === 'Abdomen' || nb === 'defspine001' || nb === 'spine' || nb === 'rigspine2') {
      this.aimBones.push({ bone: child, factor: 0.6, last: new THREE.Quaternion() });
    }
    // Socket-gun rig arm chain — norms collapse the per-pack naming
    // (UpperArmr / Base_HumanRUpperarm / forearmr all land here).
    {
      const chains = holdChains();
      for (let role = 0; role < chains.length; role += 1) {
        const norms = chains[role]!;
        if (norms.has(nb)) {
          this.holdBones.push({ bone: child, role, off: new THREE.Quaternion(...(this.holdQuats[role] ?? [0, 0, 0, 1])), last: new THREE.Quaternion(), bind: child.quaternion.clone() });
          break;
        }
      }
    }
    if (PoseControl.STEADY_BONES.has(nb)) {
      this.steadyBones.push({ bone: child, bind: child.quaternion.clone() });
    }
    if (AIM_BONE_MASK.has(nb) || AIM_TORSO_BONES.has(nb)) {
      this.locoBones.push({ bone: child, last: new THREE.Quaternion(), cached: false });
    }
  }

  // Foot-snap rig for retargeted clips on the robot rig (UAL doesn't
  // drive its IK foot bones). The mannequin's feet are real in-chain
  // bones — nothing to snap.
  captureFootBone(child: THREE.Object3D, model: THREE.Group): void {
    const side = child.name === 'FootL' ? 'L' : 'R';
    const shin = model.getObjectByName(`LowerLeg${side}`);
    const tip = model.getObjectByName(`LowerLeg${side}_end`);
    if (shin && tip) {this.footSnaps.push({ foot: child, shin, tip });}
  }

  /** Build the masked aim layer: Pistol_Aim_* clips filtered down to
   *  the arm chain so they pose the weapon hold over any locomotion clip. LoopOnce+clamp — they are static poses, so they
   *  play once and hold at full weight set per frame from aimPitch. */
  buildAimLayer(mixer: THREE.AnimationMixer, animations: Map<string, THREE.AnimationAction>, torso = false): void {
    if (this.aimNeutral && this.aimUp && this.aimDown) {return;}
    const mask = torso ? new Set([...AIM_BONE_MASK, ...AIM_TORSO_BONES]) : AIM_BONE_MASK;
    const mk = (name: string): THREE.AnimationAction | null => {
      const src = animations.get(name)?.getClip();
      if (!src) {return null;}
      const tracks = src.tracks.filter((t): boolean =>
        mask.has(normBone(t.name.slice(0, t.name.indexOf('.')))));
      if (tracks.length === 0) {return null;}
      const clip = new THREE.AnimationClip(`${name  }.aim`, src.duration, tracks);
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.setEffectiveWeight(0);
      a.play();
      return a;
    };
    this.aimUp = mk('Pistol_Aim_Up') ?? mk('UAL_Pistol_Aim_Up');
    this.aimNeutral = mk('Pistol_Aim_Neutral') ?? mk('UAL_Pistol_Aim_Neutral');
    this.aimDown = mk('Pistol_Aim_Down') ?? mk('UAL_Pistol_Aim_Down');
    if (!this.aimNeutral) {logger.debug('Aim layer unavailable — no Pistol_Aim clips');}
  }

  /** Reveal that a shot went out — ramps the spine lock. */
  fire(): void { this.armedT = 0.45; }

  update(dt: number, mixer: THREE.AnimationMixer | null,
       currentAction: THREE.AnimationAction | null,
       currentClipName: string | null, playingUAL: boolean,
       root?: THREE.Object3D, state?: string): void {
    // Remove last frame's pitch BEFORE the mixer writes. The mixer skips
    // bones whose track value didn't change, so without this the multiply
    // would accumulate on a stale pitched value and the bone spins.
    if (this.poseApplied) {
      for (const ab of this.aimBones) {
        ab.bone.quaternion.multiply(_pitchQuat.copy(ab.last).invert());
      }
      for (const hb of this.holdBones) {
        hb.bone.quaternion.multiply(_pitchQuat.copy(hb.last).invert());
      }
    }
    // Masked aim layer — weights must land BEFORE mixer.update samples the
    // pose. Suppressed while a full-body oneshot (shoot/hit/death) owns the
    // arms so it doesn't fight the reaction pose.
    let oneshot = oneshotOwnsArms(currentAction, currentClipName);
    if (oneshot && this.holdShoots && currentClipName != null && /Fire|Shoot|Shot/.test(currentClipName)) {oneshot = false;}
    this.aimPitchSm += (this.aimPitch - this.aimPitchSm) * Math.min(dt * 12, 1);
    let procPitch = this.aimPitchSm;
    if (this.aimNeutral) {
      const t = Math.max(-1, Math.min(1, this.aimPitchSm / PoseControl.AIM_CLIP_RAD));
      const w = oneshot ? 0 : 1;
      this.aimNeutral.setEffectiveWeight((1 - Math.abs(t)) * w);
      this.aimUp?.setEffectiveWeight(Math.max(0, t) * w);
      this.aimDown?.setEffectiveWeight(Math.max(0, -t) * w);
      // The clips cover ±AIM_CLIP_RAD; procedural pitch tops up the rest.
      procPitch = this.aimPitchSm - t * PoseControl.AIM_CLIP_RAD;
    }
    if (mixer) {
      mixer.update(dt);
    }
    this.applySpineLock(dt);
    const holdOn = (this.wantHoldPose || (this.holdIdle && state === 'idle')) && !this.holdBaked;
    if (holdOn || this.holdW > 0) {
      // Full-body oneshots own the arms while weighted in. Everything
      // else keeps the hold: cyber's retargeted clips pose the arm chain
      // wrong on their own (mannequin axis bake lands splayed), so the
      // fixed hip-fire grip IS the correction — blend only so oneshot
      // transitions don't pop. holdW also decays after holdOn drops
      // (idle-gated rigs leaving idle) so the pose releases cleanly.
      this.holdW += (holdOn && !oneshot ? 6 : -6) * dt;
      this.holdW = Math.min(1, Math.max(0, this.holdW));
      if (this.holdW > 0) {for (const hb of this.holdBones) {
        // Slerp toward BIND pose first — composing the fixed raise on top
        // of the animated track means the arm flails with every clip
        // frame (the retargeted tracks are garbage on this rig anyway).
        hb.bone.quaternion.slerp(hb.bind, this.holdW);
        hb.last.identity().slerp(hb.off, this.holdW);
        hb.bone.quaternion.multiply(hb.last).normalize();
      }}
    }
    // Ground-loco torso pin — post-mixer so the cache captures the fully
    // layered pose (aim layer included), and the restore lands on top of
    // whatever the loco clip left in the masked bones. Runs before the
    // procedural pitch pass so aim still applies on top either way.
    const loco = this.lockLocoTorso && (state === 'walk' || state === 'run');
    this.locoW = Math.min(1, Math.max(0, this.locoW + (loco ? 6 : -6) * dt));
    if (this.locoW > 0 || !loco) {
      for (const lb of this.locoBones) {
        if (!lb.cached) { lb.last.copy(lb.bone.quaternion); lb.cached = true; continue; }
        if (this.locoW > 0) { lb.bone.quaternion.slerp(lb.last, this.locoW); }
        else { lb.last.copy(lb.bone.quaternion); }
      }
    }
    if (procPitch) {for (const ab of this.aimBones) {
      if (root) {
        // Pitch around the model's world-space right axis — bone local X
        // is a yaw axis on some rigs (polyart), where a naive local-X
        // multiply turned aim pitch into a left/right gun sweep. `last`
        // stores the local-frame equivalent so the pre-mixer un-pitch
        // restores exactly.
        ab.bone.getWorldQuaternion(_boneWorld);
        _pitchQuat.setFromAxisAngle(_right.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(_rootWorld)), -procPitch * ab.factor);
        ab.last.copy(_boneWorld).invert().multiply(_pitchQuat).multiply(_boneWorld);
      } else {
        // Negative X tilts up for positive pitch (looking up)
        ab.last.setFromAxisAngle(X_AXIS, -procPitch * ab.factor);
      }
      // normalize(): a non-unit quat here scales the bone's whole
      // subtree (|q|² in matrixWorld) - once it starts it runs away
      // exponentially and the model-stretch canary catches fingers
      // flung to 1e10m on extreme aim pitch.
      ab.bone.quaternion.multiply(ab.last).normalize();
    }}
    this.poseApplied = Boolean(procPitch) || this.holdW > 0;
    this.snapFeetToShins(playingUAL);
  }

  // Spine lock while firing: slerp the torso chain back to bind pose.
  // Post-mixer so the clip's residual (post-dampenSway) stride roll
  // can't drag the aimed arm chain side to side; ~0.45s per shot so
  // continuous fire holds the lock.
  private applySpineLock(dt: number): void {
    this.armedT = Math.max(0, this.armedT - dt);
    this.armed += ((this.armedT > 0 ? 1 : 0) - this.armed) * Math.min(dt * 12, 1);
    if (this.armed > 0.01 && this.wantSpineLock) {
      for (const sb of this.steadyBones) {sb.bone.quaternion.slerp(sb.bind, this.armed);}
    }
  }

  // Retargeted clips don't drive the robot's IK foot bones — pin each
  // foot to its shin tip and give it the shin's orientation.
  private snapFeetToShins(playingUAL: boolean): void {
    if (!playingUAL || this.footSnaps.length === 0) {return;}
    for (const fs of this.footSnaps) {
      fs.tip.getWorldPosition(_footW); // forces fresh chain matrices
      const parent = fs.foot.parent!;
      fs.foot.position.copy(parent.worldToLocal(_footW));
      fs.shin.getWorldQuaternion(_footQ);
      parent.getWorldQuaternion(_footPQ).invert();
      fs.foot.quaternion.copy(_footPQ.multiply(_footQ));
    }
  }
}
