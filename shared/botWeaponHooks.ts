import { getWeaponStats, WEAPON_FIRE_INTERVAL_S, type WeaponType } from './weapons.js';
import type { BotLoadout } from './botLoadouts.js';

/** The pick-based weapon senses the brain ctx reads — ONE factory both
 *  the server senses and the offline brain feed build their hooks from.
 *  `pick(d)` returns the weapon this bot would draw at range `d`, so
 *  every hook below answers about the same draw: aim lead, fuse clock,
 *  arc drop, reach gate, orbit distance, trigger cadence, self-splash
 *  read. Diverged hand-copies already produced real drift (beams led
 *  like shells offline because `speed || 60` erased the hitscan 0 the
 *  server `?? 60` keeps). */
export function botWeaponHooks(pick: (d: number) => WeaponType, lo: BotLoadout) {
  return {
    weaponSpeed: (d: number): number => getWeaponStats(pick(d)).speed ?? 60,
    // Beams die at their ray length; fuse carriers reach carry + rain
    // radius; other shells' ceiling is gravity, not a ray.
    weaponRange: (d: number): number | undefined => {
      const ws = getWeaponStats(pick(d));
      if (ws.speed === 0) {return 55;}
      if (ws.fuseOnly && ws.maxLifetime) {return ws.speed * ws.maxLifetime + 20;}
      return undefined;
    },
    weaponFuse: (d: number): number | undefined => {
      const ws = getWeaponStats(pick(d));
      return ws.fuseOnly ? ws.maxLifetime : undefined;
    },
    weaponGravity: (d: number): boolean => getWeaponStats(pick(d)).gravity,
    // Where the fight positioner should orbit: a burst weapon's expected
    // hit fraction is the capsule footprint vs the cone at range, so the
    // distance is where the fan lands the damage still needed. Single-
    // shot guns keep the loadout's slot band.
    preferredRange: (d: number, hpFrac?: number): number | undefined => {
      const w = pick(d);
      const st = getWeaponStats(w);
      if ((st.burst ?? 0) > 1 && st.pelletSpread) {
        const need = Math.max(15, (hpFrac ?? 1) * 150 * 0.9);
        const maxDmg = (st.burst ?? 1) * st.directDamage;
        if (need >= maxDmg) {return 8;}
        return Math.min(45, Math.max(6, (0.5 / st.pelletSpread) * Math.sqrt(maxDmg / need)));
      }
      if (w === lo.near || w === lo.side) {return 10;}
      // Fuse carriers fight at carry range, not the duel band - MRV's
      // ~82m airburst is the attack; orbiting at 30m overflies the pop
      // and the fuse-solve refuses every volley.
      if (st.fuseOnly && st.maxLifetime && st.speed > 0) {return st.speed * st.maxLifetime;}
      // Arm-gated ordnance holds the arm window too: a mortar orbiting
      // at 30m fires shells that physically cannot pop (armTime 1.5s at
      // 80m/s = ~120m ballistic travel) - ~0.7x the arm travel lands
      // inside the measured 60-120m apex band.
      if ((st.armTime ?? 0) > 0 && st.speed > 0) {return st.speed * (st.armTime ?? 0) * 0.7;}
      if (w === lo.far) {return 30;}
      return undefined;
    },
    // Trigger rhythm — the legal cadence the client trigger enforces,
    // so a drawn chaingun streams and a drawn mortar deliberates.
    fireInterval: (d: number): number =>
      WEAPON_FIRE_INTERVAL_S[pick(d) as WeaponType] ?? 0.45,
    // Blast geometry of the same pick — the self-splash read prices
    // what this shell would do to its own shooter.
    weaponAoe: (d: number): { r: number; dmg: number } => {
      const w = getWeaponStats(pick(d));
      return { r: w.aoeRadius ?? 0, dmg: w.aoeDamage ?? 0 };
    },
  };
}
