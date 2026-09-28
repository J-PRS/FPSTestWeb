import { MoveSim, type MoveInput, type MoveState, type Vec3Like } from '../../shared/movement.ts';
import { hmHeight, hmNormal, type Heightfield } from '../../shared/heightfield.ts';
import { logger } from './logger.ts';

/**
 * Server-side movement shadow — every player gets a MoveSim fed by their
 * inputMove traffic and stepped each room tick against the room's
 * heightfield. Today it runs in shadow mode: the client's reported
 * position remains truth (same as before), while the sim's position is
 * compared against each report. Divergence beyond a tolerance is a
 * speedhack/teleport signal — the plausibility check can only see
 * consecutive-report deltas, while the sim sees the WHOLE trajectory.
 *
 * Divergence policy: drift under ~8m is normal (ping + prediction). Over
 * that we resync the sim to the report and count it — sustained big
 * divergence is logged so it can feed kicks later.
 */
class FieldSurface {
  constructor(private f: Heightfield) {}
  getHeight(x: number, z: number): number { return hmHeight(this.f, x, z); }
  getNormal(x: number, z: number, out: Vec3Like): Vec3Like {
    hmNormal(this.f, x, z, out as { x: number; y: number; z: number });
    return out;
  }
}

interface Shadow {
  sim: MoveSim;
  divergences: number;
  /** Corrections throttle — a client fighting the snap reports divergent
   *  positions every tick; one correction per window is enough. */
  lastCorrection: number;
}

export class RoomMoveSim {
  private surface: FieldSurface | null;
  private shadows = new Map<string, Shadow>();
  private static readonly DIVERGENCE_M = 8;

  constructor(field: Heightfield | null) {
    this.surface = field ? new FieldSurface(field) : null;
  }

  /** Call on join/spawn — seeds the sim at the reported spot. */
  track(playerId: string, pos: Vec3Like, yaw: number): void {
    if (!this.surface) return;
    const state: MoveState = {
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw, pitch: 0, onGround: true,
    };
    this.shadows.set(playerId, { sim: new MoveSim(this.surface, state), divergences: 0, lastCorrection: 0 });
  }

  untrack(playerId: string): void { this.shadows.delete(playerId); }

  /** inputMove → sim input. Rotation/yaw comes from position reports. */
  setInput(playerId: string, input: Partial<MoveInput>): void {
    this.shadows.get(playerId)?.sim.setInput(input);
  }

  /** Knockback/AOE impulses the server itself applied — the sim must get
   *  the same delta or every blast reads as a divergence. */
  applyImpulse(playerId: string, dv: Vec3Like): void {
    const sh = this.shadows.get(playerId);
    if (!sh) return;
    const v = sh.sim.state.vel;
    v.x += dv.x; v.y += dv.y; v.z += dv.z;
  }

  /** Compare a client position report against the shadow sim. Returns the
   *  sim's own state when the report is past the divergence tolerance —
   *  the caller turns it into a client correction (witness → judge). */
  reconcile(playerId: string, pos: Vec3Like, yaw: number, vel?: Vec3Like): MoveState | null {
    const sh = this.shadows.get(playerId);
    if (!sh) return null;
    const s = sh.sim.state;
    s.yaw = yaw; // facing is client truth — sim only needs it for input dir
    if (vel) { s.vel.x = vel.x; s.vel.y = vel.y; s.vel.z = vel.z; }
    const dx = pos.x - s.pos.x, dy = pos.y - s.pos.y, dz = pos.z - s.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= RoomMoveSim.DIVERGENCE_M) return null;

    sh.divergences++;
    if (sh.divergences === 1 || sh.divergences % 20 === 0) {
      logger.warn('Move sim divergence', { playerId, dist: dist.toFixed(1), count: sh.divergences });
    }
    const now = Date.now();
    if (now - sh.lastCorrection < 400) return null;
    sh.lastCorrection = now;
    // The sim keeps its own position — resyncing onto the rejected report
    // would make the correction we just sent diverge from the next report
    // and ping-pong forever. Convergence comes from the client snapping.
    const truth: MoveState = {
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
      yaw, pitch: s.pitch, onGround: s.onGround,
    };
    return truth;
  }

  /** Declared discontinuity (teleport/respawn) — resync without counting. */
  resync(playerId: string, pos: Vec3Like, yaw: number): void {
    const sh = this.shadows.get(playerId);
    if (!sh) return;
    const s = sh.sim.state;
    sh.sim.setState({
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 }, yaw, pitch: s.pitch, onGround: true,
    });
  }

  tick(dt: number): void {
    for (const sh of this.shadows.values()) sh.sim.update(dt);
  }

  /** Server-computed position — for future authoritative use. */
  simPos(playerId: string): Vec3Like | null {
    return this.shadows.get(playerId)?.sim.state.pos ?? null;
  }
}
