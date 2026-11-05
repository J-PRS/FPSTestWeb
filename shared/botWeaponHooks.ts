import { getWeaponStats, WEAPON_FIRE_INTERVAL_S, WeaponType } from './weapons.js';
import type { BotLoadout } from './botLoadouts.js';

/** The pick-based weapon senses the brain ctx reads - ONE factory both
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
      // Gate on the BODY arm time, not armTime: GL's armTime is only its
      // dirt-skip window (bodyArmTime 0 pops bodies at any age) and
      // parking it at 42m standoff wastes a mid-slot brawler.
      const bodyArm = st.bodyArmTime ?? st.armTime;
      if ((bodyArm ?? 0) > 0 && st.speed > 0) {return st.speed * (bodyArm ?? 0) * 0.7;}
      // Pool hoses: apex is <25m but a 12m orbit paid approach deaths vs
      // standoff guns. 20m keeps the 10-25 band without the knife dive.
      if (w === WeaponType.PlasmaGun || w === WeaponType.Sprinkler) {return 20;}
      // Airtime-scaled launchers (Disc, BoltLauncher) pay x(1+flight) up
      // to x4 at 2s - the 30m far orbit earns 1.4x, an 80m stand earns
      // ~2.2x per hit, and their hitMax grows to catch the long prayer.
      if (w === lo.far) {
        if (w === WeaponType.GrenadeLauncher) {return 60;} // measured 60-120 apex
        return getWeaponStats(w).airtimeScale ? 80 : 30;
      }
      return undefined;
    },
    // Trigger rhythm - the legal cadence the client trigger enforces,
    // so a drawn chaingun streams and a drawn mortar deliberates.
    fireInterval: (d: number): number =>
      WEAPON_FIRE_INTERVAL_S[pick(d) as WeaponType] ?? 0.45,
    // Blast geometry of the same pick - the self-splash read prices
    // what this shell would do to its own shooter.
    weaponAoe: (d: number): { r: number; dmg: number } => {
      const w = getWeaponStats(pick(d));
      return { r: w.aoeRadius ?? 0, dmg: w.aoeDamage ?? 0 };
    },
  };
}
