import { ENERGY, cloakDrainPerSec } from '../../../../shared/movement.js';
import { MEND_HP_PER_SEC } from '../../../../shared/status.js';
import type { SkillsCtx } from './skills.js';

// Energy-channel toggles — cloak, shield, mend. Same economy shape:
// a cheap ante plus a continuous drain; the channel drops when the tank
// runs dry. PlayerSkills is the host (press/reset/updates delegate).
const CLOAK_COST = ENERGY.cloakCost;
const SHIELD_COST = ENERGY.shieldCost;
const SHIELD_DRAIN = ENERGY.shieldDrain;
const MEND_COST = ENERGY.mendCost;
const MEND_DRAIN = ENERGY.mendDrain;

export class SkillChannels {
  cloaked = false;
  shielded = false;
  mending = false;

  constructor(private ctx: SkillsCtx) {}

  resetAll(): void {
    this.setCloak(false);
    this.setShield(false);
    this.setMend(false);
  }

  // ---- Cloak ----
  // Toggle on Q. The drain is unconditional and regen is suppressed on
  // the Player side while cloaked.

  toggleCloak(): void {
    if (this.cloaked) { this.setCloak(false); return; }
    if (!this.ctx.spendEnergy(CLOAK_COST)) return; // can't pay the ante
    this.setCloak(true);
  }

  private setCloak(on: boolean): void {
    if (this.cloaked === on) return;
    this.cloaked = on;
    this.ctx.emitCloak(on);
  }

  updateCloak(dt: number): void {
    if (!this.cloaked) return;
    // Horizontal speed prices the upkeep: sitting still is nearly free,
    // running full tilt burns ~10x — slower is sneakier.
    const speed = Math.hypot(this.ctx.vel.x, this.ctx.vel.z);
    this.ctx.drainEnergy(cloakDrainPerSec(speed) * dt);
    if (this.ctx.energy() <= 0) this.setCloak(false); // tank dry — surface
  }

  // ---- Shield ----
  // Same economy as cloak; instead of hiding you it soaks damage into the
  // energy pool. Shield hits don't bypass the tank — a dried-up bubble pops.

  toggleShield(): void {
    if (this.shielded) { this.setShield(false); return; }
    if (!this.ctx.spendEnergy(SHIELD_COST)) return;
    this.setShield(true);
  }

  private setShield(on: boolean): void {
    if (this.shielded === on) return;
    this.shielded = on;
    this.ctx.emitShield(on);
  }

  /** Outside forces (damage soak, death) drop the bubble through the same
   *  emit path so the wire flag and FX never disagree. */
  forceShieldOff(): void { this.setShield(false); }

  updateShield(dt: number): void {
    if (!this.shielded) return;
    this.ctx.drainEnergy(SHIELD_DRAIN * dt);
    if (this.ctx.energy() <= 0) this.setShield(false); // tank dry — pop
  }

  // ---- Medkit ----
  // Energy → health conversion channel. Health itself is server-owned
  // (server regens while the mend flag is up); the client owns the energy
  // burn — dry tank = mend off. Deliberately a trickle: it patches you up
  // between fights, it doesn't win them.

  toggleMend(): void {
    if (this.mending) { this.setMend(false); return; }
    if (!this.ctx.spendEnergy(MEND_COST)) return;
    this.setMend(true);
  }

  private setMend(on: boolean): void {
    if (this.mending === on) return;
    this.mending = on;
    this.ctx.emitMend(on);
  }

  updateMend(dt: number): void {
    if (!this.mending) return;
    this.ctx.drainEnergy(MEND_DRAIN * dt);
    if (this.ctx.energy() <= 0) { this.setMend(false); return; } // tank dry — channel ends
    if (!this.ctx.netHeals()) this.ctx.healSelf(MEND_HP_PER_SEC * dt);
  }

}
