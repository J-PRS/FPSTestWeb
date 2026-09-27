import * as THREE from 'three';

/**
 * SnapshotBuffer — the remote-player interpolation core.
 *
 * The server streams position/rotation/velocity snapshots; this buffer holds
 * the last ~1s of them and answers "where should the remote be rendered right
 * now?" — a renderTime pulled back by an adaptive delay that tracks observed
 * arrival jitter (stretchy cadence from server send-suppression does NOT count
 * as jitter, or idle remotes would pin the delay at max and render stale).
 *
 * Between two snapshots the position follows a cubic Hermite whose tangents
 * are the server-reported velocities — C1-continuous, so direction changes
 * curve smoothly instead of zig-zagging across linear segments. A bogus or
 * stale velocity that overshoots wildly vs the straight lerp falls back to
 * linear (guard below). Past the newest snapshot it extrapolates velocity for
 * a bounded 250ms rather than freezing.
 *
 * Pure math + Date.now() — no scene objects, so it's unit-testable in
 * isolation from RemotePlayer's models/gizmos.
 */

export interface NetSnapshot {
  t: number; x: number; y: number; z: number;
  yaw: number; pitch: number;
  vx: number; vy: number; vz: number;
}

export class SnapshotBuffer {
  static readonly BASE_INTERP_DELAY = 100;
  static readonly MAX_INTERP_DELAY = 300;
  static readonly MAX_EXTRAPOLATE = 0.25; // s past the newest snapshot
  private static readonly RETAIN_MS = 1000;

  private snapshots: NetSnapshot[] = [];
  private pool: NetSnapshot[] = [];
  interpDelay = SnapshotBuffer.BASE_INTERP_DELAY;
  /** EMA of the observed arrival interval — send suppression stretches it
   *  well past the nominal 20Hz without being jitter. */
  arrivalInterval = 50;
  private arrivalJitter = 0;

  /** Push a server update; returns the arrival gap in ms (0 = first sample). */
  push(
    t: number,
    x: number, y: number, z: number,
    yaw: number, pitch: number,
    vx: number, vy: number, vz: number,
  ): number {
    const prev = this.snapshots.length ? this.snapshots[this.snapshots.length - 1]!.t : 0;
    const gap = prev > 0 ? t - prev : 0;
    if (gap > 10 && gap < 2000) {
      this.arrivalInterval += (gap - this.arrivalInterval) * 0.15;
      this.arrivalJitter += (Math.abs(gap - this.arrivalInterval) - this.arrivalJitter) * 0.1;
      this.interpDelay = Math.min(
        SnapshotBuffer.MAX_INTERP_DELAY,
        SnapshotBuffer.BASE_INTERP_DELAY + this.arrivalJitter * 2,
      );
    }

    const snap = this.pool.pop() ?? { t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0 };
    snap.t = t; snap.x = x; snap.y = y; snap.z = z;
    snap.yaw = yaw; snap.pitch = pitch;
    snap.vx = vx; snap.vy = vy; snap.vz = vz;
    this.snapshots.push(snap);

    const cutoff = t - SnapshotBuffer.RETAIN_MS;
    while (this.snapshots.length > 2 && this.snapshots[0]!.t < cutoff) {
      this.pool.push(this.snapshots.shift()!);
    }
    return gap;
  }

  /** Sample the render position/rotation for right now. */
  sample(outPos: THREE.Vector3, outRot: { yaw: number; pitch: number },
         fallbackPos: THREE.Vector3, fallbackYaw: number, fallbackPitch: number): void {
    const renderTime = Date.now() - this.interpDelay;
    const snaps = this.snapshots;

    if (snaps.length === 0) {
      outPos.copy(fallbackPos);
      outRot.yaw = fallbackYaw;
      outRot.pitch = fallbackPitch;
      return;
    }

    const newest = snaps[snaps.length - 1]!;
    if (renderTime >= newest.t) {
      // Past the buffer — extrapolate briefly from the newest snapshot
      const ext = Math.min(SnapshotBuffer.MAX_EXTRAPOLATE, (renderTime - newest.t) / 1000);
      outPos.set(newest.x + newest.vx * ext, newest.y + newest.vy * ext, newest.z + newest.vz * ext);
      outRot.yaw = newest.yaw;
      outRot.pitch = newest.pitch;
      return;
    }

    // Find the pair straddling renderTime
    let i = snaps.length - 2;
    while (i >= 0 && snaps[i]!.t > renderTime) i--;
    if (i < 0) {
      const s = snaps[0]!;
      outPos.set(s.x, s.y, s.z);
      outRot.yaw = s.yaw;
      outRot.pitch = s.pitch;
      return;
    }

    const s0 = snaps[i]!;
    const s1 = snaps[i + 1]!;
    const span = s1.t - s0.t;
    const a = span > 0 ? (renderTime - s0.t) / span : 1;

    const spanSec = span / 1000;
    const ddx = s1.x - s0.x, ddy = s1.y - s0.y, ddz = s1.z - s0.z;
    const lx = s0.x + ddx * a, ly = s0.y + ddy * a, lz = s0.z + ddz * a;
    let useHermite = false;
    if (spanSec > 0 && spanSec < 0.5) {
      const t2 = a * a, t3 = t2 * a;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + a;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const hx = h00 * s0.x + h10 * s0.vx * spanSec + h01 * s1.x + h11 * s1.vx * spanSec;
      const hy = h00 * s0.y + h10 * s0.vy * spanSec + h01 * s1.y + h11 * s1.vy * spanSec;
      const hz = h00 * s0.z + h10 * s0.vz * spanSec + h01 * s1.z + h11 * s1.vz * spanSec;
      const ox = hx - lx, oy = hy - ly, oz = hz - lz;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      // Overshoot tolerance: fraction of segment length (min 0.5m absolute)
      if (ox * ox + oy * oy + oz * oz < (0.5 * dist + 0.5) * (0.5 * dist + 0.5)) {
        outPos.set(hx, hy, hz);
        useHermite = true;
      }
    }
    if (!useHermite) {
      outPos.set(lx, ly, lz);
    }
    // Yaw: lerp along shortest arc
    let dy = s1.yaw - s0.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    outRot.yaw = s0.yaw + dy * a;
    outRot.pitch = s0.pitch + (s1.pitch - s0.pitch) * a;
  }

  /** Recycle the whole buffer (teleport/disconnect reset). */
  clear(): void {
    this.pool.push(...this.snapshots);
    this.snapshots.length = 0;
  }

  get size(): number { return this.snapshots.length; }
}
