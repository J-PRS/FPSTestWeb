import { simMs } from './simClock.ts';
import { getWeaponStats, WeaponType, scaledDirectDamage, isInstagibWeapon, INSTAGIB_RAILGUN_DAMAGE, HEALBEAM_ENERGY, HEALBEAM_PER_TICK, HEALBEAM_RANGE } from '../../shared/weapons.ts';
import { gunGameAllows } from '../../shared/gunGame.ts';
import { healPool } from './healPool.ts';
import { lgTickDamage } from '../../shared/combat.ts';
import { perkMods } from '../../shared/perks.ts';
import { segSolidHit } from '../../shared/solidWorld.ts';
import type { CombatHandler, CombatDeps } from './CombatHandler.ts';
import { wallNow , wallMs} from './wallClock.ts';

// Server-owned attacks - no client claim to validate because the sim
// (creature AI, server bots) IS the attacker. They still route through
// serverHit/applyHit so kill credit and respawns stay in lockstep.

// Structural slice - geometry reads + the damage funnels, nothing else.
export type AttackHost = Pick<CombatHandler,
  '_solids' | 'solidIndex' | 'chargeBank' | 'playerManager' | 'hb' | 'friendly' | 'serverHit'
> & { deps: Pick<CombatDeps, 'energyOf' | 'drainEnergy' | 'mods' | 'gunRungOf' | 'gunGameHeld'> };

export function crawlerAttack(h: AttackHost, targetId: string, damage: number, species = 'crawler', from?: { x: number; y: number; z: number }): void {
    // A creature wedged inside/behind geometry can't bite through it -
    // contact range is the sim's gate; the wall is ours.
    if (from && h._solids.length > 0) {
      const target = h.playerManager.getPlayer(targetId);
      if (target) {
        const eye = { x: target.position.x, y: target.position.y + 1, z: target.position.z };
        if (segSolidHit(from, eye, h._solids, h.solidIndex ?? undefined)) {return;}
      }
    }
    const label = `${species[0]!.toUpperCase()}${species.slice(1)} bite`;
    h.serverHit('environment', targetId, damage, label, { hb: 'crawlbite' });
  }

export function botAttack(h: AttackHost, shooterId: string, targetId: string, weaponType: number, airtime?: number, shotId?: string): void {

    const shooter = h.playerManager.getPlayer(shooterId);
    if (!shooter || shooter.isDead) {return;}
    const mods = h.deps.mods?.() ?? {};
    // Instagib whitelist - bot melee/kit drift can't land damage the
    // modifier doesn't allow (spawn() already refused the body; this
    // covers the body-less intents like the knife-range punch).
    if (mods.instagib === true && !isInstagibWeapon(weaponType)) {return;}
    // Gungame ladder - same backstop for the rung weapon (covers the
    // body-less intents: melee punch, beam ticks, hold-out sidearms).
    if (mods.gungame === true && !gunGameAllows(h.deps.gunRungOf?.(shooterId) ?? 0, weaponType, mods.igun === true)) {return;}
    if (mods.gungame === true) {h.deps.gunGameHeld?.(shooterId, weaponType);}
    // Heal beam: same tick/cadence path as the damage beam, but the
    // payload is HP on a friend and the ammo is the shooter's own jet
    // tank - pocket-healing a push costs the bot its climb out.
    if (weaponType === WeaponType.HealBeam) {
      const target = h.playerManager.getPlayer(targetId);
      if (!target || target.isDead || !h.friendly(shooterId, targetId)) {return;}
      const dist = Math.hypot(target.position.x - shooter.position.x, target.position.y - shooter.position.y, target.position.z - shooter.position.z);
      if (dist > HEALBEAM_RANGE) {return;}
      const tank = h.deps;
      if (tank.energyOf && (tank.energyOf(shooterId) ?? 0) < HEALBEAM_ENERGY) {return;}
      tank.drainEnergy?.(shooterId, HEALBEAM_ENERGY);
      healPool(target, HEALBEAM_PER_TICK);
      target.forceSendUntil = wallMs(wallNow() + 900);
      h.hb('heal.beam');
      return;
    }
    shooter.protectedUntil = simMs(0); // firing breaks your own spawn shield
    // Melee carries its damage on the aoe line (instant cone, directDamage 0)
    // - falling back to it keeps bot punches non-zero. airtime feeds the
    // skillshot ramp for sim shells (melee/beam callers pass none).
    const stats = getWeaponStats(weaponType);
    // Reach is judged at CONTACT time, not aim time: the swing may be
    // aimed at a lastSeen memory point while the live target skis away
    // - a 4.5m punch landing at 100m was real (melee probe: 60-137m
    // hits). Same contract fireAtBall's bug punch already honors.
    if (weaponType === WeaponType.Melee) {
      const target = h.playerManager.getPlayer(targetId);
      if (!target || target.isDead) {return;}
      const d = Math.hypot(target.position.x - shooter.position.x, target.position.y - shooter.position.y, target.position.z - shooter.position.z);
      if (d > (stats?.aoeRadius ?? 3.2) + 2.4) {return;} // swing radius + capsule
    }
    // Slugger bonus re-derived, not sent: cap + row speed decide it
    // identically on both ends (spawn clamps, hit pays back).
    const sm = perkMods(shooter.perk);
    const slug = sm.projSpeedCap > 0 && stats.speed > sm.projSpeedCap ? Math.min(1.5, stats.speed / sm.projSpeedCap) : 1;
    let damage = (scaledDirectDamage(weaponType, airtime) || stats.aoeDamage) * sm.directDamage * slug;
    // Instagib/igun: the flat 200 slug - airtime ramp, perk multipliers
    // and the slugger speed bonus all sit out. igun pays it on EVERY
    // weapon (the ladder's difficulty is handling, not damage).
    if (mods.igun === true || (mods.instagib === true && weaponType === WeaponType.Railgun)) {damage = INSTAGIB_RAILGUN_DAMAGE;}
    // Bot beams ramp down like human ones - the beam-rider loadout pays
    // the same hold-decay a client's beam does.
    if (weaponType === WeaponType.Lightning) {
      const n = h.chargeBank.step(shooterId, targetId);
      damage = lgTickDamage(n) * perkMods(shooter.perk).directDamage;
      const victim = h.playerManager.getPlayer(targetId);
      if (victim && !victim.isDead && !h.friendly(shooterId, targetId)) {h.chargeBank.bank(victim, h.chargeBank.withheldFor(n));}
    }
    h.serverHit(shooterId, targetId, damage, 'Bot hit', { weapon: weaponType, shotId, air: airtime });
  }

