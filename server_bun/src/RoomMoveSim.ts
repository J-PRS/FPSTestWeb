import { MoveSim, ENERGY, type MoveInput, type MoveState, type Vec3Like } from '../../shared/movement.ts';
import { STATUS } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
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
  // ---- Energy model ---------------------------------------------------
  // The wire `jet` bit is a claim the tank has fuel; the sim must model
  // the same economy or infinite-jet claims read as valid trajectories.
  // Skill drains (cloak/shield/mend) and activation antes are inferred
  // from the status bits the client already sends on inputMove.
  energy: number;
  jetDrain: number;   // perk multipliers — declared at join
  jetRegen: number;
  energyRegen: number;
  /** Raw claimed jet bit — the sim sees it gated by modeled energy. */
  jetWanted: boolean;
  /** Sum of active per-second skill drains from claimed status bits. */
  skillDrainPerSec: number;
  /** Cloak/shield/mend all suppress the tank recharge client-side too. */
  skillSuppressRegen: boolean;
  /** For ante deduction on 0→1 bit transitions. */
  lastStatus: number;
}

export class RoomMoveSim {
  private surface: FieldSurface | null;
  private shadows = new Map<string, Shadow>();
  private static readonly DIVERGENCE_M = 8;

  constructor(field: Heightfield | null) {
    this.surface = field ? new FieldSurface(field) : null;
  }

  /** Call on join/spawn — seeds the sim at the reported spot. */
  track(playerId: string, pos: Vec3Like, yaw: number, perk?: string): void {
    if (!this.surface) return;
    const state: MoveState = {
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw, pitch: 0, onGround: true,
    };
    const mods = perkMods(perk);
    this.shadows.set(playerId, {
      sim: new MoveSim(this.surface, state), divergences: 0, lastCorrection: 0,
      energy: ENERGY.max,
      jetDrain: mods.jetDrain, jetRegen: mods.jetRegen, energyRegen: mods.energyRegen,
      jetWanted: false, skillDrainPerSec: 0, skillSuppressRegen: false, lastStatus: 0,
    });
  }

  untrack(playerId: string): void { this.shadows.delete(playerId); }

  /** inputMove → sim input. Rotation/yaw comes from position reports.
   *  `status` is the claimed toggle bits — used to model skill energy
   *  drain and activation antes (rising-edge costs). */
  setInput(playerId: string, input: Partial<MoveInput>, status = 0): void {
    const sh = this.shadows.get(playerId);
    if (!sh) return;
    if (input.jetHeld !== undefined) sh.jetWanted = input.jetHeld;
    sh.sim.setInput({ ...input, jetHeld: sh.jetWanted && sh.energy > 0 });

    // Rising-edge antes — the client pays the activation cost when the
    // bit comes up; the sim must mirror it or cloaked jetters desync.
    const rising = status & ~sh.lastStatus;
    if (rising & STATUS.CLOAK) sh.energy = Math.max(0, sh.energy - ENERGY.cloakCost);
    if (rising & STATUS.SHIELD) sh.energy = Math.max(0, sh.energy - ENERGY.shieldCost);
    if (rising & STATUS.MEND) sh.energy = Math.max(0, sh.energy - ENERGY.mendCost);
    sh.lastStatus = status;

    sh.skillDrainPerSec =
      (status & STATUS.CLOAK ? ENERGY.cloakDrain : 0) +
      (status & STATUS.SHIELD ? ENERGY.shieldDrain : 0) +
      (status & STATUS.MEND ? ENERGY.mendDrain : 0);
    sh.skillSuppressRegen = sh.skillDrainPerSec > 0;
  }

  /** Energy refunds the world grants — gem pickup half-tank refill. */
  grantEnergy(playerId: string, amount: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.energy = Math.min(ENERGY.max, sh.energy + amount);
  }

  /** Energy burns outside the input stream — shield damage soak. */
  drainEnergy(playerId: string, amount: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.energy = Math.max(0, sh.energy - amount);
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
    for (const sh of this.shadows.values()) {
      // Jet economy: thrust only while the modeled tank has fuel, drain
      // while burning, recharge only when off jet AND no toggle skill is
      // running (client-side rule — all three pause recharge).
      const jetting = sh.jetWanted && sh.energy > 0;
      if (jetting) sh.energy -= ENERGY.jetDrain * sh.jetDrain * dt;
      if (sh.skillDrainPerSec > 0) sh.energy -= sh.skillDrainPerSec * dt;
      if (!jetting && !sh.skillSuppressRegen) {
        sh.energy = Math.min(ENERGY.max, sh.energy + ENERGY.jetCharge * sh.jetRegen * sh.energyRegen * dt);
      }
      sh.energy = Math.max(0, sh.energy);
      sh.sim.setInput({ jetHeld: jetting });
      sh.sim.update(dt);
    }
  }

  /** Server-computed position — for future authoritative use. */
  simPos(playerId: string): Vec3Like | null {
    return this.shadows.get(playerId)?.sim.state.pos ?? null;
  }
}
