import { getWeaponStats, WeaponType } from '../../shared/weapons.ts';
import { lgTickDamage } from '../../shared/combat.ts';
import { perkMods } from '../../shared/perks.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { CombatHandler } from './CombatHandler.ts';

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

export function botAttack(h: CombatHandler, shooterId: string, targetId: string, weaponType: number): void {
    const shooter = h.playerManager.getPlayer(shooterId);
    if (!shooter || shooter.isDead) return;
    shooter.protectedUntil = 0; // firing breaks your own spawn shield
    // Melee carries its damage on the aoe line (instant cone, directDamage 0)
    // — falling back to it keeps bot punches non-zero.
    const stats = getWeaponStats(weaponType);
    let damage = (stats.directDamage || stats.aoeDamage) * perkMods(shooter.perk).directDamage;
    // Bot beams ramp down like human ones — the beam-rider loadout pays
    // the same hold-decay a client's beam does.
    if (weaponType === WeaponType.Lightning) {
      const n = h.chargeBank.step(shooterId, targetId);
      damage = lgTickDamage(n) * perkMods(shooter.perk).directDamage;
      const victim = h.playerManager.getPlayer(targetId);
      if (victim && !victim.isDead && !h.friendly(shooterId, targetId)) h.chargeBank.bank(victim, h.chargeBank.withheldFor(n));
    }
    h.serverHit(shooterId, targetId, damage, 'Bot hit', { weapon: weaponType });
  }

