import * as THREE from 'three';
import { GRAVITY } from '../core/config.js';
import { classCapsule } from '../../../shared/botClasses.js';
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
  /** Blends from predicted back to server position after sim resumes
   *  (0 = done). */
  private reconcileBlend = 0;
  /** Last raw server position — velocity estimation must not read the
   *  extrapolated path or it feeds its own error forward. */
  private lastServerPosition = new THREE.Vector3();

  constructor(private h: InterpHost) {}

  get simulating(): boolean { return this._simulating; }
  get lastUpdate(): number { return this.lastUpdateTime; }

  /** One server position update arrived — push the snapshot, refresh
   *  velocity estimates, and (when the DR window allows) blend back.
   *  `serverMs` is the snapshot's server-timeline stamp (tickSeq×50);
   *  callers without a server clock omit it and arrival time is used. */
  onUpdate(targetPosition: { x: number; y: number; z: number }, targetRotation: { yaw: number; pitch: number }, ping: number, serverVelocity?: { x: number; y: number; z: number }, serverMs?: number): void {
    const prevUpdateMs = this.lastServerUpdateMs;
    this.lastUpdateTime = Date.now();
    const stamp = serverMs ?? this.lastUpdateTime;
    this.lastServerUpdateMs = stamp;

    // Simulating and an update arrived → stop simulating and blend back.
    // Inside the prediction window the server hasn't reflected the
    // knockback yet, so the sim keeps running.
    if (this._simulating && this.predictionTimer <= 0) {
      this._simulating = false;
      this.reconcileBlend = 0.1; // ~100ms ease — a snap reads as a teleport
      logger.debug(`RESUMED updates, blending to server position`, { playerId: this.h.playerId });
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
      this.reconcileBlend = 0;
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
    if (timeSinceUpdate > drThreshold && !this._simulating && !localDriven) {
      this._simulating = true;
      logger.debug(`STARTING dead reckoning`, { playerId: this.h.playerId, silentMs: timeSinceUpdate });
    }

    if (this._simulating) {
      if (this.predictionTimer > 0) {
        this.predictionTimer = Math.max(0, this.predictionTimer - dt);
      }
      this.simStep(dt);
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
  }

  /** Respawn reset — the sim can't carry a corpse's state forward. */
  reset(pos: THREE.Vector3): void {
    this._simulating = false;
    this.net.clear();
    this.predictionTimer = 0;
    this.reconcileBlend = 0;
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
    this.sample(sampledPos, sampledRot);
    const p = this.h.position;

    if (this.reconcileBlend > 0) {
      // Reconciliation blend: recovering from simulation, ease onto the
      // sampled path instead of snapping
      this.reconcileBlend = Math.max(0, this.reconcileBlend - dt);
      const blendStrength = Math.min(1, dt / Math.max(0.001, this.reconcileBlend + dt));
      p.lerp(sampledPos, blendStrength);
    } else {
      // Directly place on the interpolated path — smooth by construction
      p.copy(sampledPos);
    }

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

  // Dead-reckoning physics — gravity + terrain ground clamp, no air
  // friction (matches game physics: the local player has no air drag).
  private simStep(dt: number): void {
    const p = this.h.position;
    this.simulatedVelocity.y += GRAVITY * dt;

    p.x += this.simulatedVelocity.x * dt;
    p.y += this.simulatedVelocity.y * dt;
    p.z += this.simulatedVelocity.z * dt;

    if (this.h.terrain) {
      const groundY = this.h.terrain.getHeight(p.x, p.z);
      const {eye} = classCapsule(this.h.armorClass);
      if (p.y < groundY + eye) { // keep EYE at eye height above feet
        p.y = groundY + eye;
        this.simulatedVelocity.y = 0;
        this.simulatedVelocity.x *= 0.9; // Friction
        this.simulatedVelocity.z *= 0.9;
      }
    }
  }
}
