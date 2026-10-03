import { getWeaponStats, WeaponType, scaledDirectDamage, HEALBEAM_ENERGY, HEALBEAM_PER_TICK, HEALBEAM_RANGE } from '../../shared/weapons.ts';
import { healPool } from './healPool.ts';
import { lgTickDamage } from '../../shared/combat.ts';
import { perkMods } from '../../shared/perks.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { CombatHandler } from './CombatHandler.ts';
import { wallNow } from './wallClock.ts';

// Server-owned attacks — no client claim to validate because the sim
// (creature AI, server bots) IS the attacker. They still route through
// serverHit/applyHit so kill credit and respawns stay in lockstep.

export function crawlerAttack(h: CombatHandler, targetId: string, damage: number, species = 'crawler', from?: { x: number; y: number; z: number }): void {
    // A creature wedged inside/behind geometry can't bite through it —
    // contact range is the sim's gate; the wall is ours.
    if (from && h._solids.length) {
      const target = h.playerManager.getPlayer(targetId);
      if (target) {
        const eye = { x: target.position.x, y: target.position.y + 1.0, z: target.position.z };
        if (segSolidHit(from, eye, h._solids, h.solidIndex ?? undefined)) return;
      }
    }
    const label = `${species[0]!.toUpperCase()}${species.slice(1)} bite`;
    h.serverHit('environment', targetId, damage, label, { hb: 'crawlbite' });
  }

export function botAttack(h: CombatHandler, shooterId: string, targetId: string, weaponType: number, airtime?: number, shotId?: string): void {
    const shooter = h.playerManager.getPlayer(shooterId);
    if (!shooter || shooter.isDead) return;
    // Heal beam: same tick/cadence path as the damage beam, but the
    // payload is HP on a friend and the ammo is the shooter's own jet
    // tank — pocket-healing a push costs the bot its climb out.
    if (weaponType === WeaponType.HealBeam) {
      const target = h.playerManager.getPlayer(targetId);
      if (!target || target.isDead || !h.friendly(shooterId, targetId)) return;
      const dist = Math.hypot(target.position.x - shooter.position.x, target.position.y - shooter.position.y, target.position.z - shooter.position.z);
      if (dist > HEALBEAM_RANGE) return;
      const tank = h.deps;
      if (tank.energyOf && (tank.energyOf(shooterId) ?? 0) < HEALBEAM_ENERGY) return;
      tank.drainEnergy?.(shooterId, HEALBEAM_ENERGY);
      healPool(target, HEALBEAM_PER_TICK);
      target.forceSendUntil = wallNow() + 900;
      h.hb('heal.beam');
      return;
    }
    shooter.protectedUntil = 0; // firing breaks your own spawn shield
    // Melee carries its damage on the aoe line (instant cone, directDamage 0)
    // — falling back to it keeps bot punches non-zero. airtime feeds the
    // skillshot ramp for sim shells (melee/beam callers pass none).
    const stats = getWeaponStats(weaponType);
    let damage = (scaledDirectDamage(weaponType, airtime) || stats.aoeDamage) * perkMods(shooter.perk).directDamage;
    // Bot beams ramp down like human ones — the beam-rider loadout pays
    // the same hold-decay a client's beam does.
    if (weaponType === WeaponType.Lightning) {
      const n = h.chargeBank.step(shooterId, targetId);
      damage = lgTickDamage(n) * perkMods(shooter.perk).directDamage;
      const victim = h.playerManager.getPlayer(targetId);
      if (victim && !victim.isDead && !h.friendly(shooterId, targetId)) h.chargeBank.bank(victim, h.chargeBank.withheldFor(n));
    }
    h.serverHit(shooterId, targetId, damage, 'Bot hit', { weapon: weaponType, shotId });
  }

