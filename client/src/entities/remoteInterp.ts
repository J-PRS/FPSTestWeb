import * as THREE from 'three';
import { GRAVITY } from '../core/config.js';
import { MOVEMENT_CONFIG } from '../../../shared/movement.js';
import { classCapsule, classMass } from '../../../shared/botClasses.js';
import type { Terrain } from '../world/terrain.js';
import { ChildLogger } from '../core/Logger.js';
import { SnapshotBuffer } from './remoteSnapshots.js';

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
  /** Last raw server position — velocity estimation must not read the
   *  extrapolated path or it feeds its own error forward. */
  private lastServerPosition = new THREE.Vector3();

  constructor(private h: InterpHost) {}

  get simulating(): boolean { return this._simulating; }
  get lastUpdate(): number { return this.lastUpdateTime; }
  /** The render delay this remote's buffer settled on — reported via
   *  clientStats so lag-comp validates at the ghost the shooter saw,
   *  not a fixed 200ms constant that understates jittered links. */
  get interpDelay(): number { return this.net.interpDelay; }

  /** One server position update arrived — push the snapshot, refresh
   *  velocity estimates, and (when the DR window allows) blend back.
   *  `serverMs` is the snapshot's server-timeline stamp (tickSeq×50);
   *  callers without a server clock omit it and arrival time is used. */
  onUpdate(targetPosition: { x: number; y: number; z: number }, targetRotation: { yaw: number; pitch: number }, ping: number, serverVelocity?: { x: number; y: number; z: number }, serverMs?: number): void {
    const prevUpdateMs = this.lastServerUpdateMs;
    this.lastUpdateTime = Date.now();
    const stamp = serverMs ?? this.lastUpdateTime;
    this.lastServerUpdateMs = stamp;

    // Simulating and an update arrived → arm the converge phase inside
    // the same sim (steer back onto the path, physically). The sim and
    // the steer share simulatedVelocity, so staying in one mode removes
    // the DR→converge→interp hand-off seam. Inside the prediction window
    // the server hasn't reflected the knockback yet — free-run continues.
    if (this._simulating && this.convergeTimer <= 0 && this.predictionTimer <= 0) {
      this.convergeTimer = 0.45;
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
    // into the DR launch vector. Skipped during the prediction window.
    if (!teleported && this.predictionTimer <= 0) {
      if (this.lastServerPosition.lengthSq() > 0) {
        const serverDt = (stamp - prevUpdateMs) / 1000;
        if (serverDt > 0) {
          this.simulatedVelocity.set(
            (targetPosition.x - this.lastServerPosition.x) / serverDt,
            (targetPosition.y - this.lastServerPosition.y) / serverDt,
            (targetPosition.z - this.lastServerPosition.z) / serverDt
          );
        }
      }
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
    if ((timeSinceUpdate > drThreshold || (this.net.atExtCap && timeSinceUpdate > 200)) && !this._simulating && !localDriven) {
      // Seed from the wire velocity — differentiating snapshot positions
      // folds arrival noise into the launch vector (a jittered pair
      // reports phantom speed the real sim never had).
      if (this.h.serverVelocity.lengthSq() > 0) {
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
    } else if (!localDriven) {
      this.interp(dt);
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
  }

  /** Predicted knockback: run the victim through dead reckoning for ~1
   *  RTT while the real impulse (server → victim client → position
   *  updates) travels the network. Seeds with the victim's last server
   *  velocity + the exact server impulse math (dir*mag XZ, 0.5*mag up /
   *  0.3 pull). Snapshots are cleared so interpolation can't resample
   *  the pre-hit path after the window — that stale-buffer resample was
   *  the old snap-back bug. */
  predict(fromPos: THREE.Vector3, impulseMag: number, pull = false): void {
    // Inside an active window the seed already owns the flight — a second
    // predicted blast re-seeding would STACK impulses (serverVelocity +
    // impulse, again) and refresh the timer, so sustained mortar spam
    // launched remotes tens of meters past any real record. The arriving
    // wire truth carries the extra blasts; this prediction is cosmetic.
    if (this.predictionTimer > 0) return;
    const p = this.h.position;
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
    const gap = Math.hypot(sampledPos.x - p.x, sampledPos.y - p.y, sampledPos.z - p.z);
    const stepBudget = Math.max(0.5, this.h.velocity.length() * dt * 3 + 0.25);
    // Every gap steers — no upper bound: a big drift that outlived its
    // converge window used to fall through to the raw copy and snap by
    // the whole remainder. Genuine teleports never reach here (onUpdate's
    // plausibility gate and reseat/reset clear the buffer first), so the
    // converge is always rejoining a continuous path.
    if (this.lastUpdateTime > 0 && !freshSeed && gap > stepBudget) {
      this._simulating = true;
      this.convergeTimer = Math.max(this.convergeTimer, 0.35);
      this.convergeStep(dt);
      return;
    }

    // Directly place on the interpolated path — smooth by construction
    p.copy(sampledPos);

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
    // desired velocity that reaches the target within ~horizon
    const dvx = (target.x - p.x) / horizon;
    const dvy = (target.y - p.y) / horizon;
    const dvz = (target.z - p.z) / horizon;
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
      const groundY = this.h.terrain.getHeight(p.x, p.z);
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
