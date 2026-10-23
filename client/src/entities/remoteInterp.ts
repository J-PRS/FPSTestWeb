import * as THREE from 'three';
import { GRAVITY } from '../core/config.js';
import { MOVEMENT_CONFIG } from '../../../shared/movement.js';
import { classCapsule, classMass } from '../../../shared/botClasses.js';
import type { Terrain } from '../world/terrain.js';
import { ChildLogger } from '../core/Logger.js';
import { SnapshotBuffer } from './remoteSnapshots.js';
import { monitorOn, violation } from '../core/liveMonitor.js';

const logger = new ChildLogger('RemotePlayer');

/**
 * RemoteInterp — the netcode half of RemotePlayer: snapshot ingestion,
 * adaptive-delay interpolation, dead-reckoning simulation, and the
 * predicted-knockback window. Owns the buffer + every timing field those
 * paths need so the host class stays about the rendered body.
 */

/** Flat host surface — the body the sim writes into. */
export interface InterpHost {
  position: THREE.Vector3;
  previousPosition: THREE.Vector3;
  rotation: { yaw: number; pitch: number; roll: number };
  velocity: THREE.Vector3;
  serverVelocity: THREE.Vector3;
  terrain: Terrain | null;
  playerId: string;
  /** Armor tier — dead reckoning grounds the eye at the class's height. */
  armorClass?: string;
  /** Wire ski flag — a DR'd remote holding ski stays frictionless above
   *  walk speed, same rule the shared sim applies. */
  wireSki?: boolean;
  /** Wire jet flag — a DR'd remote holding jet climbs instead of
   *  falling at raw gravity (the "why did he drop mid-air" tell). */
  wireJet?: boolean;
}

// Scratch — shared across instances, never retained past the call
const _extrapolated = new THREE.Vector3();
const _sampledRot = { yaw: 0, pitch: 0 };
// Snapshot pool copies field-by-field, so a shared zero is a safe arg.
const _ZERO_VEL = { x: 0, y: 0, z: 0 };

export class RemoteInterp {
  // Snapshot buffer + adaptive interp delay — the pure netcode half lives
  // in remoteSnapshots.ts (unit-testable, no scene deps)
  private net = new SnapshotBuffer();
  private targetPosition = new THREE.Vector3();
  private targetRotation = { yaw: 0, pitch: 0 };
  private ping = 0; // connection ping in ms — the knockback window sizes off it
  private lastUpdateTime = 0;   // CLIENT wall ms of the last update — liveness/DR only
  private silencePeakMs = 0;    // duration of the gap that just ended — keeps the leash DR earned
  private silencePeakAt = 0;
  private lastServerUpdateMs = 0; // SERVER ms of the last update (tickSeq×50, or wall when no server clock)
  private _simulating = false;  // dead reckoning is running
  private simulatedVelocity = new THREE.Vector3();
  /** Forced local prediction window — bridges the server round-trip after
   *  a predicted knockback so interpolation doesn't fight the launch. */
  private predictionTimer = 0;
  /** Physics-constrained rejoin window — instead of lerping the remote
   *  back onto the buffered path (a visible slide), a steering controller
   *  applies the acceleration a real player could produce to converge
   *  onto it (the "simulate the fake input" approach: the correction is
   *  an in-world maneuver, never a warp). Seconds remaining; 0 = off. */
  private convergeTimer = 0;
  /** Last converge's sampled target — consecutive samples give the path's
   *  true speed even when the wire strips VEL from sparse records. */
  private prevSample = new THREE.Vector3();
  private prevSampleAt = 0;
  /** Last raw server position — velocity estimation must not read the
   *  extrapolated path or it feeds its own error forward. */
  private lastServerPosition = new THREE.Vector3();
  /** Throttle for the render-drift monitor — a steering episode would
   *  otherwise log every frame. */
  private driftLogAt = 0;
  /** Reachable-envelope monitor: last drawn position + arming flag. A
   *  legit re-seat clears the flag instead of reporting its own jump. */
  private prevDraw = new THREE.Vector3();
  private prevDrawValid = false;
  private reachLogAt = 0;
  private wireGapLogAt = 0;
  /** Past this, no input combination explains one frame's displacement —
   *  terminalVelocity is 100 and impulses don't stack that high. */
  private static readonly REACH_CAP = 150;

  constructor(private h: InterpHost) {}

  get simulating(): boolean { return this._simulating; }
  /** The sim's own velocity — identical to h.velocity during sim, but
   *  readable even if another system overwrites the host field. */
  get simVelocity(): THREE.Vector3 { return this.simulatedVelocity; }
  /** Converge window active — distinguishes steering episodes from raw
   *  dead reckoning in diagnostics. */
  get converging(): boolean { return this.convergeTimer > 0; }
  get lastUpdate(): number { return this.lastUpdateTime; }
  /** Last raw server position — wire truth, untouched by blend/DR.
   *  Diagnostics that mean "the server sank this body" must read this,
   *  not the blended host position. */
  get wirePosition(): THREE.Vector3 { return this.lastServerPosition; }
  /** The render delay this remote's buffer settled on — reported via
   *  clientStats so lag-comp validates at the ghost the shooter saw,
   *  not a fixed 200ms constant that understates jittered links. */
  get interpDelay(): number { return this.net.interpDelay; }
  /** Actual staleness of the last drawn sample (delay minus extrapolation
   *  overshoot) — the shooter's literal view epoch for lag-comp reports. */
  get viewLagMs(): number { return this.net.viewLagMs; }
  /** Server-time epoch of the last drawn frame — the shooter's literal
   *  view instant the lag-comp ghost samples at. */
  get viewEpochT(): number { return this.net.viewEpochT; }
  /** Buffered truth at a server-time epoch — history, not projection. */
  sampleGhostAt(t: number, out: THREE.Vector3): boolean { return this.net.sampleAt(t, out); }
  /** Buffer starved → extrapolation cap hit: each underrun is a visible
   *  freeze/dead-reckon episode. extCapMs is total severity. */
  get underruns(): number { return this.net.underruns; }
  get extCapMs(): number { return this.net.extCapMsTotal; }
  get atCap(): boolean { return this.net.atExtCap; }

  /** One server position update arrived — push the snapshot, refresh
   *  velocity estimates, and (when the DR window allows) blend back.
   *  `serverMs` is the snapshot's server-timeline stamp (tickSeq×50);
   *  callers without a server clock omit it and arrival time is used. */
  onUpdate(targetPosition: { x: number; y: number; z: number }, targetRotation: { yaw: number; pitch: number }, ping: number, serverVelocity?: { x: number; y: number; z: number }, serverMs?: number): void {
    const prevUpdateMs = this.lastServerUpdateMs;
    const nowMs = Date.now();
    if (this.lastUpdateTime > 0) {
      this.silencePeakMs = nowMs - this.lastUpdateTime;
      this.silencePeakAt = nowMs;
    }
    this.lastUpdateTime = nowMs;
    const stamp = serverMs ?? this.lastUpdateTime;
    this.lastServerUpdateMs = stamp;

    // Simulating and an update arrived → arm the converge phase inside
    // the same sim (steer back onto the path, physically). The sim and
    // the steer share simulatedVelocity, so staying in one mode removes
    // the DR→converge→interp hand-off seam. Inside the prediction window
    // the server hasn't reflected the knockback yet — free-run continues.
    const wasConverging = this.convergeTimer > 0;
    if (this._simulating && this.convergeTimer <= 0 && this.predictionTimer <= 0) {
      const drift = Math.hypot(
        targetPosition.x - this.h.position.x,
        targetPosition.y - this.h.position.y,
        targetPosition.z - this.h.position.z);
      this.convergeTimer = this.convergeBudget(drift);
      logger.debug(`RESUMED updates, converging to server position`, { playerId: this.h.playerId });
    }

    this.ping = ping;

    // Undeclared teleport: no physically-plausible path reaches this
    // snapshot from the last one — a respawn, a stale post-reconnect
    // frame, a lead step. Interpolating across it smears a speed-ghost
    // across the gap (a 30m slide reads far worse than a clean snap),
    // and feeding the jump into the DR velocity estimate launches the
    // next dead-reckon at an impossible speed. Declared teleports reseat
    // through the wire handler before they ever reach here — this net
    // catches everything else: wipe the buffer and DR state so the new
    // truth stands alone, and skip the velocity delta this frame.
    const jumpSpanSec = (stamp - prevUpdateMs) / 1000;
    const jumpDist = this.lastServerPosition.lengthSq() > 0 && jumpSpanSec > 0
      ? Math.hypot(
          targetPosition.x - this.lastServerPosition.x,
          targetPosition.y - this.lastServerPosition.y,
          targetPosition.z - this.lastServerPosition.z)
      : 0;
    const teleported = jumpDist > Math.max(8, jumpSpanSec * 90 + 4);
    if (teleported) {
      this.net.clear();
      this._simulating = false;
      this.convergeTimer = 0;
      this.lastServerPosition.set(targetPosition.x, targetPosition.y, targetPosition.z);
      if (serverVelocity) {
        this.simulatedVelocity.set(serverVelocity.x, serverVelocity.y, serverVelocity.z);
      }
    }

    this.targetPosition.set(targetPosition.x, targetPosition.y, targetPosition.z);
    this.targetRotation.yaw = targetRotation.yaw;
    this.targetRotation.pitch = targetRotation.pitch;

    // Push onto the snapshot buffer — it also tracks arrival jitter and
    // adapts the render delay (see remoteSnapshots.ts)
    this.net.push(
      stamp,
      targetPosition,
      targetRotation,
      serverVelocity ?? _ZERO_VEL,
      this.lastUpdateTime,
    );

    if (serverVelocity) {
      this.h.serverVelocity.set(serverVelocity.x, serverVelocity.y, serverVelocity.z);
    }

    // Estimate velocity from consecutive server positions (not the
    // extrapolated position). serverMs deltas are jitter-free server
    // ticks — dividing by arrival gaps was feeding transport noise
    // into the DR launch vector. Skipped during the prediction window,
    // and while converge owns the body — clumped WAN arrivals produce
    // near-zero pos deltas that would stomp the steered velocity to
    // ~1.4m/s, leaving ghosts trailing the path for seconds.
    if (!teleported && this.predictionTimer <= 0) {
      this.reseedSimVelocity(stamp - prevUpdateMs, targetPosition, wasConverging);
      this.lastServerPosition.set(targetPosition.x, targetPosition.y, targetPosition.z);
    }
  }

  /** Per-frame netcode step — picks sim vs interp and runs it. The host
   *  calls this after its own liveness/owner checks; model/gizmo upkeep
   *  stays on the host. */
  step(dt: number, localDriven: boolean): void {
    // Dead reckoning trigger scaled to the measured update cadence: ~2
    // missed packets at that player's actual send rate. Fixed 300/450ms
    // thresholds flapped DR on/off when heartbeats arrived slower than
    // their nominal 250ms interval.
    const drThreshold = Math.min(1500, Math.max(350, this.net.arrivalInterval * 2.5));
    const timeSinceUpdate = Date.now() - this.lastUpdateTime;
    // The sampler clamps past the extrapolation cap — the remote would
    // freeze-frame on stale truth for the rest of the silence window, so
    // DR takes over at the cap rather than waiting out the threshold.
    // But on a suppressed stream (250ms+ arrivals) the cap + a fixed
    // silence flap DR on/off every packet — DR free-runs, converge
    // steers back, repeat. Only a stream starving well past its own
    // cadence earns the takeover.
    const starveMs = Math.max(200, this.net.arrivalInterval * 1.5);
    if ((timeSinceUpdate > drThreshold || (this.net.atExtCap && timeSinceUpdate > starveMs)) && !this._simulating && !localDriven) {
      // Seed preference: the pos-delta estimate already lives in
      // simulatedVelocity (recomputed per update, jitter-free server-t
      // deltas) — realized motion, including collision reality. Wire vel
      // goes STALE on far seats (sparse records strip VEL/ROT entirely —
      // a 60m/s remote dead-reckons on minutes-old heading — the ghost
      // treadmill the dual-diff exposed). Wire vel only wins inside a
      // predicted-knockback window (its pos-delta is deliberately skipped)
      // or when no delta estimate exists at all.
      if (this.h.serverVelocity.lengthSq() > 0 &&
          (this.predictionTimer > 0 || this.lastServerPosition.lengthSq() === 0)) {
        this.simulatedVelocity.copy(this.h.serverVelocity);
      }
      this._simulating = true;
      logger.debug(`STARTING dead reckoning`, { playerId: this.h.playerId, silentMs: timeSinceUpdate });
    }

    if (this._simulating) {
      if (this.predictionTimer > 0) {
        this.predictionTimer = Math.max(0, this.predictionTimer - dt);
      }
      if (this.convergeTimer > 0) {
        this.convergeStep(dt);
      } else {
        this.simStep(dt);
      }
      // The sim's velocity IS the remote's velocity while it owns the
      // body — interp() maintains h.velocity itself, so without this the
      // field reads ~0/stale through every DR episode and consumers
      // (anim speed, probes, jerk metrics) judge a moving body frozen.
      this.h.velocity.copy(this.simulatedVelocity);
      this.watchReach(dt);
      this.watchWireGap();
      this.clampWireGap(dt);
    } else if (!localDriven) {
      this.interp(dt);
      this.watchReach(dt);
      this.watchWireGap();
      this.clampWireGap(dt);
    }
    // localDriven: position/rotation were already written by the owner —
    // interpolating would stomp them with a delayed snapshot sample.
  }

  /** Hard re-seat (teleport/dummy hook): the buffer and every timing
   *  field go back to zero-truth at `pos`. */
  reseat(pos: THREE.Vector3): void {
    this.targetPosition.copy(pos);
    this.net.clear();
    this.lastUpdateTime = Date.now();
    this._simulating = false;
    this.convergeTimer = 0;
    this.prevDrawValid = false; // legit re-seat — not impossible motion
  }

  /** Respawn reset — the sim can't carry a corpse's state forward. The
   *  empty-buffer fallback samples targetPosition, so it must move to the
   *  spawn seat too or the next frame drags the render back to the corpse. */
  reset(pos: THREE.Vector3): void {
    this._simulating = false;
    this.net.clear();
    this.predictionTimer = 0;
    this.convergeTimer = 0;
    this.targetPosition.copy(pos);
    this.lastServerPosition.copy(pos);
    this.lastServerUpdateMs = Date.now();
    this.lastUpdateTime = Date.now();
    this.prevDrawValid = false; // legit re-seat — not impossible motion
  }

  /** Predicted knockback: run the victim through dead reckoning for ~1
   *  RTT while the real impulse (server → victim client → position
   *  updates) travels the network. Seeds with the victim's last server
   *  velocity + the exact server impulse math (dir*mag XZ, 0.5*mag up /
   *  0.3 pull). Snapshots are cleared so interpolation can't resample
   *  the pre-hit path after the window — that stale-buffer resample was
   *  the old snap-back bug. */
  predict(fromPos: THREE.Vector3, impulseMag: number, pull = false, dirFrom?: THREE.Vector3): void {
    // NaN seed → NaN simulatedVelocity + a cleared interp buffer: the
    // remote ghosts into nowhere until the next wire row re-roots it.
    if (!Number.isFinite(fromPos.x + fromPos.y + fromPos.z + impulseMag)) {return;}
    // Inside an active window the seed already owns the flight — a second
    // predicted blast re-seeding would STACK impulses (serverVelocity +
    // impulse, again) and refresh the timer, so sustained mortar spam
    // launched remotes tens of meters past any real record. The arriving
    // wire truth carries the extra blasts; this prediction is cosmetic.
    if (this.predictionTimer > 0) {return;}
    // Direction off the same position the envelope was evaluated at —
    // callers pass the ghost epoch pos; the rendered body can sit meters
    // away on a fast mover, skewing the launch angle.
    const p = dirFrom ?? this.h.position;
    const dx = p.x - fromPos.x;
    const dy = p.y - fromPos.y;
    const dz = p.z - fromPos.z;
    const dist = Math.hypot(dx, dy, dz) || 0.001;
    this.simulatedVelocity.copy(this.h.serverVelocity);
    const s = pull ? -1 : 1;
    this.simulatedVelocity.x += (dx / dist) * impulseMag * s;
    this.simulatedVelocity.y += (pull ? 0.3 : 0.5) * impulseMag;
    this.simulatedVelocity.z += (dz / dist) * impulseMag * s;
    this.net.clear();
    this._simulating = true;
    this.convergeTimer = 0;
    // Window: ping + one server tick + interp delay, clamped
    this.predictionTimer = Math.min(0.6, Math.max(0.15, (this.ping + 200) / 1000));
  }

  // Sample the snapshot buffer at renderTime = now - adaptive interp delay
  // (the math lives in remoteSnapshots.ts — Hermite tangents from the
  // server-reported velocities, linear fallback on wild overshoot)
  private sample(outPos: THREE.Vector3, outYawPitch: { yaw: number; pitch: number }): void {
    this.net.sample(outPos, outYawPitch,
      this.targetPosition, this.targetRotation.yaw, this.targetRotation.pitch);
  }

  /** Read-only monitor: drawn pose vs the buffer's own sample — the drift
   *  the eye reads. Throttled, and kept out of interp() so its complexity stays put. */
  private watchGap(gap: number, perp: number, svLen: number, freshSeed: boolean): void {
    if (!monitorOn() || this.lastUpdateTime <= 0 || freshSeed || gap <= 1.5) {return;}
    const now = performance.now();
    if (now - this.driftLogAt <= 500) {return;}
    this.driftLogAt = now;
    violation('render-drift', { id: this.h.playerId, gap: Number(gap.toFixed(2)), perp: Number(perp.toFixed(2)), serverSpeed: Number(svLen.toFixed(1)), delayMs: Math.round(this.net.interpDelay), underruns: this.net.underruns });
  }

  private watchSnap(gap: number): void {
    if (!monitorOn()) {return;}
    violation('snap', { id: this.h.playerId, gap: Number(gap.toFixed(2)), speed: Number(this.h.velocity.length().toFixed(1)) });
  }

  /** Reachable-envelope check — monitor-only. The drawn body's per-frame
   *  displacement must be something legal inputs could produce in dt:
   *  a sling through a Hermite overshoot or a warp-back reads as
   *  hundreds of m/s for one frame (terminal fall is 100, stacked
   *  impulses don't reach 150). Reports the mode that drew it so a
   *  converge-churn vs interp-overshoot vs DR-runaway split is visible. */
  private watchReach(dt: number): void {
    const p = this.h.position;
    if (!monitorOn() || dt <= 0) {return;}
    if (!this.prevDrawValid) {
      this.prevDraw.copy(p);
      this.prevDrawValid = true;
      return;
    }
    const dist = Math.hypot(p.x - this.prevDraw.x, p.y - this.prevDraw.y, p.z - this.prevDraw.z);
    this.prevDraw.copy(p);
    const speed = dist / dt;
    if (speed <= RemoteInterp.REACH_CAP) {return;}
    const now = performance.now();
    if (now - this.reachLogAt <= 500) {return;}
    this.reachLogAt = now;
    let mode = 'interp';
    if (this._simulating) {mode = this.convergeTimer > 0 ? 'converge' : 'sim';}
    violation('impossible-motion', {
      id: this.h.playerId,
      speed: Number(speed.toFixed(0)),
      dist: Number(dist.toFixed(2)),
      mode,
      delayMs: Math.round(this.net.interpDelay),
      underruns: this.net.underruns,
    });
  }

  /** Render-vs-wire leash — the gap between the drawn body and the last
   *  raw server position (the cyan debug ghost). The leash is deliberate:
   *  render delay honestly puts the body ~speed·delay behind the wire, so
   *  the cap is speed·delay + slack, not a fixed distance. Past it the
   *  render is drawing somewhere the wire never was — the "slung, then
   *  warped back" signature, and a WYSIWYG hole: shots verified against
   *  the wire can't hit what the client drew out there. */
  private watchWireGap(): void {
    if (!monitorOn() || this.lastServerPosition.lengthSq() === 0) {return;}
    const p = this.h.position;
    const w = this.lastServerPosition;
    const gap = Math.hypot(p.x - w.x, p.y - w.y, p.z - w.z);
    const cap = this.wireGapCap();
    if (gap <= cap) {return;}
    const now = performance.now();
    if (now - this.wireGapLogAt <= 500) {return;}
    this.wireGapLogAt = now;
    let mode = 'interp';
    if (this._simulating) {mode = this.convergeTimer > 0 ? 'converge' : 'sim';}
    violation('wire-gap', {
      id: this.h.playerId,
      gap: Number(gap.toFixed(2)),
      cap: Number(cap.toFixed(1)),
      mode,
      delayMs: Math.round(this.net.interpDelay),
      underruns: this.net.underruns,
    });
  }

  /** Honest leash radius around the last wire position: how far real
   *  motion could be from the newest record — speed over (render delay
   *  + silence since that record) with slack. Silence is in the budget
   *  because DR legitimately keeps moving while the wire freezes; the
   *  sim's own 40m XZ drift cap stops a silent wire's runaway instead. */
  private wireGapCap(): number {
    const speed = Math.max(this.h.serverVelocity.length(), this.h.velocity.length());
    const now = Date.now();
    // Silence resets the instant a post-gap packet lands, but the DR
    // drift it earned doesn't — clamping against the shrunken cap on the
    // first frame after silence teleports the body. The peak decays
    // linearly, so the leash shrinks over the same window converge
    // steers back in.
    const silence = Math.max(
      now - this.lastUpdateTime,
      Math.max(0, this.silencePeakMs - (now - this.silencePeakAt)));
    const horizonSec = (this.net.interpDelay + silence) / 1000;
    return Math.max(8, speed * horizonSec * 1.5 + 3);
  }

  /** Hard enforcement of the leash — rendering farther than wireGapCap
   *  is drawing somewhere the server never put the body, which is
   *  fiction AND a WYSIWYG hole (shots verify against the wire). Pull
   *  the body back onto the boundary sphere — rate-limited to reachable
   *  speed: an instant pull on a frame where the wire jumped IS the
   *  sling-then-warp this clamp exists to prevent. */
  private clampWireGap(dt: number): void {
    const w = this.lastServerPosition;
    if (w.lengthSq() === 0) {return;}
    const p = this.h.position;
    const dx = p.x - w.x, dy = p.y - w.y, dz = p.z - w.z;
    const gap = Math.hypot(dx, dy, dz);
    const cap = this.wireGapCap();
    if (gap <= cap) {return;}
    // Cap the pull speed at REACH_CAP: a teleport/respawn writes ~600m/s
    // into h.velocity for a frame, and letting the pull inherit it turns
    // the leash into the teleport it's meant to prevent.
    const speed = Math.min(RemoteInterp.REACH_CAP,
      Math.max(this.h.serverVelocity.length(), this.h.velocity.length()));
    const pull = Math.min(gap - cap, speed * dt) / gap;
    p.x -= dx * pull; p.y -= dy * pull; p.z -= dz * pull;
  }

  // Interpolate between buffered server snapshots (skipped during
  // dead-reckoning simulation)
  private interp(dt: number): void {
    const sampledPos = _extrapolated;
    const sampledRot = _sampledRot;
    // A post-clear buffer holds only fresh truth — its first sample is a
    // re-seat, not a drifted path, so it snaps directly and skips the
    // steering gate entirely. Read the flag before sample() consumes it.
    const { freshSeed } = this.net;
    this.sample(sampledPos, sampledRot);
    const p = this.h.position;

    // Extrapolation resample seam: when renderTime outruns the newest
    // snapshot the sampler coasts on velocity; the late packet then
    // lands BEHIND the coasted point and a raw copy snaps the render
    // backward by ~v·ext. Route that discontinuity through the steering
    // converge instead — same physically-capped rejoin DR exits use —
    // so a jittered link steers the ghost rather than warping it.
    const gx = sampledPos.x - p.x, gy = sampledPos.y - p.y, gz = sampledPos.z - p.z;
    const gap = Math.hypot(gx, gy, gz);
    // Seams split by direction: an offset ALONG the remote's velocity is
    // invisible — it only advances/lags the ghost on its own line.
    // Perpendicular offset is the pop (sideways warp). At 40m/s every
    // pushed snapshot re-bends the path by ~1-2m longitudinally; gating
    // converge on the perpendicular component is what lets straight-line
    // skiers ride pure interpolation instead of steering every packet.
    const sv = this.h.serverVelocity;
    const svLen = Math.hypot(sv.x, sv.y, sv.z);
    let perp = gap;
    if (svLen > 1 && gap > 0.01) {
      const along = (gx * sv.x + gy * sv.y + gz * sv.z) / svLen;
      perp = Math.sqrt(Math.max(0, gap * gap - along * along));
    }
    this.watchGap(gap, perp, svLen, freshSeed);
    // Cap at ~1m: scaling the copy-threshold with full speed lets a
    // 44m/s remote snap 2.4m in one frame — a budget that big isn't a
    // seam anymore, it's a pop. Larger gaps steer through converge.
    const stepBudget = Math.min(1, Math.max(0.5, this.h.velocity.length() * dt * 3 + 0.25));
    // Seam budget caps the steer: small gaps are jitter seams — converge
    // steers them. A gap past ~40m is NOT a seam: it means the ghost
    // state is garbage (starved DR + stale vel launch), and a
    // physically-capped chase can NEVER close it against a 60m/s remote —
    // the converge timer expires mid-run, interp re-arms it, and the
    // replica treadmills hundreds of meters behind truth for seconds.
    // Snap to the sampled path instead: a sudden jump is exactly what a
    // lost replica is, and it's one frame of honesty vs seconds of ghost.
    if (this.lastUpdateTime > 0 && !freshSeed && gap > 40) {
      this.watchSnap(gap);
      p.copy(sampledPos);
      this.h.velocity.copy(this.h.serverVelocity);
      this.floorToGround(p);
      this.h.rotation.yaw = sampledRot.yaw;
      this.h.rotation.pitch = sampledRot.pitch;
      this.h.rotation.roll = 0;
      this.h.previousPosition.copy(p);
      return;
    }
    // Seam rejoin. Perpendicular drift (sideways warp) is the visible
    // pop — it goes through the accel-capped steering sim with a window
    // sized to the physics (convergeBudget; a flat 0.35s expired
    // mid-chase and re-armed every frame — permanent churn). Purely
    // longitudinal gaps — the common jitter-coast seam — absorb a slice
    // per frame instead: the ghost eases back onto its own timeline, no
    // mode switch, nothing to see.
    if (this.lastUpdateTime > 0 && !freshSeed && gap > stepBudget) {
      if (perp > stepBudget) {
        this._simulating = true;
        this.convergeTimer = Math.max(this.convergeTimer, this.convergeBudget(gap));
        this.convergeStep(dt);
        return;
      }
      const k = Math.min(1, 12 * dt);
      p.x += gx * k; p.y += gy * k; p.z += gz * k;
    } else {
      // Directly place on the interpolated path — smooth by construction
      p.copy(sampledPos);
    }
    // Rendered-terrain floor: the wire eye clamps to the SMOOTH field
    // server-side, but the rendered level-0 chord sits above it in
    // gullies — a grounded remote placed raw sinks under the visible
    // ground (invisible bots). Same floor simStep applies.
    this.floorToGround(p);

    // Rotation comes straight from the sampled interpolation (already smoothed)
    this.h.rotation.yaw = sampledRot.yaw;
    this.h.rotation.pitch = sampledRot.pitch;
    this.h.rotation.roll = 0; // Roll is not networked, only used for death physics

    // Update velocity for extrapolation (estimate from recent movement)
    if (dt > 0) {
      this.h.velocity.x = (p.x - this.h.previousPosition.x) / dt;
      this.h.velocity.y = (p.y - this.h.previousPosition.y) / dt;
      this.h.velocity.z = (p.z - this.h.previousPosition.z) / dt;
    }
  }

  /** How long a converge needs to actually close `gap`: ACCEL_CAP-bound
   *  ramp to the chase velocity plus the steering horizon. A flat 0.35s
   *  expires mid-chase on a fast remote — interp re-arms converge on the
   *  next frame and the body lives in perpetual micro-steer churn
   *  (visible wobble, never settled). ~1.4s ceiling keeps a lost replica
   *  honest — bigger failures take the >40m snap path. */
  /** Drawn ground height at (x,z): the rendered clipmap chord can sit
   *  above the smooth collider field in gullies, so visible burial keys
   *  off the max of both — every render path floors the same way. */
  private groundY(x: number, z: number): number {
    const t = this.h.terrain!;
    return Math.max(t.getHeight(x, z), t.getRenderedHeight(x, z));
  }

  /** Clamp the rendered position's eye above the drawn surface — a body
   *  under it reads as buried even when the wire sits legitimately below
   *  the smooth field. Visual only; no velocity side-effects. */
  private floorToGround(p: THREE.Vector3): void {
    if (!this.h.terrain) {return;}
    const floor = this.groundY(p.x, p.z) + classCapsule(this.h.armorClass).eye;
    if (p.y < floor) {p.y = floor;}
  }

  private convergeBudget(gap: number): number {
    const horizon = Math.min(0.6, Math.max(0.18, gap * 0.04));
    const chaseVel = gap / horizon + this.h.serverVelocity.length();
    return Math.min(1.4, chaseVel / 80 + horizon);
  }

  /** Velocity estimate from consecutive wire positions — while converge
   *  owns the body its steering keeps the velocity: clumped WAN arrivals
   *  produce near-zero pos deltas that would stomp it to ~1.4m/s and
   *  leave ghosts trailing the path for seconds. */
  private reseedSimVelocity(spanMs: number, targetPosition: { x: number; y: number; z: number }, wasConverging: boolean): void {
    if (spanMs <= 0 || wasConverging || this.lastServerPosition.lengthSq() === 0) {return;}
    this.simulatedVelocity.set(
      (targetPosition.x - this.lastServerPosition.x) / (spanMs / 1000),
      (targetPosition.y - this.lastServerPosition.y) / (spanMs / 1000),
      (targetPosition.z - this.lastServerPosition.z) / (spanMs / 1000)
    );
  }

  /** Steering convergence — the fake-input answer to a drifted remote:
   *  instead of blending positions, a critically-damped controller picks
   *  the acceleration that closes the gap to the buffered path within a
   *  physical accel cap, so the rejoin reads as the remote steering, not
   *  sliding. Ends early once close; a real teleport never comes through
   *  here (onUpdate's plausibility gate wipes instead). */
  private convergeStep(dt: number): void {
    const p = this.h.position;
    const target = _extrapolated;
    const rot = _sampledRot;
    this.sample(target, rot);

    // Horizon scales with the gap: a 12m rejoin gets ~0.5s of steering
    // (reads as the remote recovering its path), a 1m seam stays snappy.
    const dist = Math.hypot(target.x - p.x, target.y - p.y, target.z - p.z);
    const horizon = Math.min(0.6, Math.max(0.18, dist * 0.04));
    // desired velocity = target's own velocity + closing term — chasing
    // only the static gap gives dv = dist/horizon, which stalls at
    // ~27m on a 44m/s remote (the steer literally cannot catch it).
    // Sparse far-seat records strip VEL, so serverVelocity can read ~0 —
    // the chase baseline then collapses to dist/horizon ≈ walking speed
    // and the ghost trails the path forever. The delta between this
    // converge's sample and the last gives the path's true speed.
    const pvDt = Date.now() - this.prevSampleAt;
    const pvx = pvDt > 0 ? (target.x - this.prevSample.x) / (pvDt / 1000) : 0;
    const pvy = pvDt > 0 ? (target.y - this.prevSample.y) / (pvDt / 1000) : 0;
    const pvz = pvDt > 0 ? (target.z - this.prevSample.z) / (pvDt / 1000) : 0;
    this.prevSample.copy(target);
    this.prevSampleAt = Date.now();
    const wireVel = this.h.serverVelocity.lengthSq() > 1;
    const baseX = wireVel ? this.h.serverVelocity.x : pvx;
    const baseY = wireVel ? this.h.serverVelocity.y : pvy;
    const baseZ = wireVel ? this.h.serverVelocity.z : pvz;
    const dvx = (target.x - p.x) / horizon + baseX;
    const dvy = (target.y - p.y) / horizon + baseY;
    const dvz = (target.z - p.z) / horizon + baseZ;
    // accel = (desiredVel - vel)/dt, critically damped, capped to what a
    // jet-burning player could produce (~jetForceDir + gravity-class)
    const ACCEL_CAP = 80;
    let ax = (dvx - this.simulatedVelocity.x) / Math.max(dt, 0.001);
    let ay = (dvy - this.simulatedVelocity.y) / Math.max(dt, 0.001);
    let az = (dvz - this.simulatedVelocity.z) / Math.max(dt, 0.001);
    const aMag = Math.hypot(ax, ay, az);
    if (aMag > ACCEL_CAP) {
      const s = ACCEL_CAP / aMag; ax *= s; ay *= s; az *= s;
    }
    this.simulatedVelocity.x += ax * dt;
    this.simulatedVelocity.y += ay * dt;
    this.simulatedVelocity.z += az * dt;
    p.x += this.simulatedVelocity.x * dt;
    p.y += this.simulatedVelocity.y * dt;
    p.z += this.simulatedVelocity.z * dt;

    // Conditional terrain floor: when the wire feet ride at/above the
    // drawn surface, a ghost under it is a chord-shortcut artifact — the
    // sampled path bends through a ridge the wire went over, and chasing
    // it drags the body visibly under terrain (the "pulled under" soak
    // reports — burial measured ~97% chord-shortcut vs ~3% wire dips).
    // A genuinely under-field wire (the case this path was left
    // unfloored for — unbury rescues it server-side) keeps the ghost
    // unfloored: surfacing it there hovers it 5-12m off truth.
    const w = this.lastServerPosition;
    if (this.h.terrain && w.lengthSq() > 0) {
      const wireBuried = this.h.terrain.getRenderedHeight(w.x, w.z) - (w.y - classCapsule(this.h.armorClass).eye) > 0.5;
      if (!wireBuried) {this.floorToGround(p);}
    }
    this.h.rotation.yaw = rot.yaw;
    this.h.rotation.pitch = rot.pitch;
    this.convergeTimer = Math.max(0, this.convergeTimer - dt);
    const close = p.distanceToSquared(target) < 0.04; // 0.2m
    if (close || this.convergeTimer <= 0) {
      this.convergeTimer = 0;
      this._simulating = false;
      this.h.velocity.copy(this.simulatedVelocity);
    }
  }

  // Dead-reckoning physics — gravity + terrain ground clamp, no air
  // friction (matches game physics: the local player has no air drag).
  private simStep(dt: number): void {
    const p = this.h.position;
    this.simulatedVelocity.y += GRAVITY * dt;

    // Held jet on the wire burns thrust — the shared sim's
    // jetForceUp/mass plus the directional share along travel (remotes
    // carry no WASD bits, so velocity is the honest input proxy; the
    // forward-cap dropout keeps it under jetMaxFwdAccel like the real
    // sim). Without it a jetting remote visibly falls during a gap.
    if (this.h.wireJet === true) {
      const im = dt / classMass(this.h.armorClass);
      this.simulatedVelocity.y += MOVEMENT_CONFIG.jetForceUp * im;
      const hv = Math.hypot(this.simulatedVelocity.x, this.simulatedVelocity.z);
      if (hv > 0 && hv < MOVEMENT_CONFIG.jetMaxFwdAccel) {
        const ux = this.simulatedVelocity.x / hv, uz = this.simulatedVelocity.z / hv;
        this.simulatedVelocity.x += ux * MOVEMENT_CONFIG.jetForceDir * im;
        this.simulatedVelocity.z += uz * MOVEMENT_CONFIG.jetForceDir * im;
      }
    }

    p.x += this.simulatedVelocity.x * dt;
    p.y += this.simulatedVelocity.y * dt;
    p.z += this.simulatedVelocity.z * dt;

    // Drift cap: past ~40m of horizontal extrapolation the sim is a ghost,
    // not a guess — freeze the XZ runaway (gravity still grounds them) or
    // a silent wire renders bots hundreds of meters from any real record.
    const driftX = p.x - this.lastServerPosition.x;
    const driftZ = p.z - this.lastServerPosition.z;
    if (this.lastServerPosition.lengthSq() > 0 && Math.hypot(driftX, driftZ) > 40) {
      this.simulatedVelocity.x = 0;
      this.simulatedVelocity.z = 0;
    }

    if (this.h.terrain) {
      // Feet clamp to the VISIBLE surface — the smooth heightfield can
      // dip below the rendered level-0 chord in gullies, sinking bodies
      // meters under what the player sees as ground.
      const groundY = this.groundY(p.x, p.z);
      const {eye} = classCapsule(this.h.armorClass);
      if (p.y < groundY + eye) { // keep EYE at eye height above feet
        p.y = groundY + eye;
        this.simulatedVelocity.y = 0;
        // Ski is frictionless past walk speed — a remote holding ski
        // keeps the slide, a walker bleeds the flat 0.9 ground drag.
        const hSpeed = Math.hypot(this.simulatedVelocity.x, this.simulatedVelocity.z);
        const skiing = this.h.wireSki === true && hSpeed > MOVEMENT_CONFIG.maxVelocityGround;
        if (!skiing) {
          this.simulatedVelocity.x *= 0.9;
          this.simulatedVelocity.z *= 0.9;
        }
      }
    }
  }
}
