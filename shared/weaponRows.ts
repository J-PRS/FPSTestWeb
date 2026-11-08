// Per-weapon stat rows - the data half of weaponTable.ts. Split out so the
// enum, types and helpers stay under the file-size ceiling. Shared sims,
// bots and HUDs all read these rows.
import { WeaponType, type WeaponStats } from './weaponTable.ts';

/** Explosion VFX dome = aoeRadius × this - damage always reaches a bit past
 *  the visual edge (covers the shock ring), and the two can never drift. */
export const WEAPONS: Record<number, WeaponStats> = {
  [WeaponType.BoltLauncher]: {
    aimAxis: 'arcJudge',
    fireInterval: 1.2,
    gib: true, airtimeScale: true, aoeBonus: true,
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 5, // tighter pop - the bolt's splash is graze, not zoning
    knockbackForce: 28,
    forceMode: 'push',
    speed: 120,
    gravity: true,
    bodyRadius: 0.18,
    hitMin: 0,
    hitMax: 8,
    hitGrow: 2,
    maxLifetime: 12, // ~1.4km - effectively "flies until it lands"; the fuse only exists so a bugged remote replica can't streak forever
  },
  [WeaponType.Disc]: {
    aimAxis: 'arcLead',
    fireInterval: 1,
    airtimeScale: true, aoeBonus: true,
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 10,
    knockbackForce: 45, // THE disc-jump weapon - strongest launcher shove (rocket=40, MRV=45)
    forceMode: 'push', // launcher disc knocks back like everything else
    speed: 80,
    gravity: false,
    bodyRadius: 0.5,
    hitMin: 0.3,
    hitMax: 8,
    hitGrow: 2,
    maxLifetime: 12, // ~960m - long prayers stay live; fuse only bounds desynced replicas
  },
  [WeaponType.Implodisc]: {
    aimAxis: 'arcLead',
    fireInterval: 1,
    airtimeScale: true,
    // Belt disc (C): the implosion - pulls targets toward the blast.
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 10, // slightly exceeds the 8m Implosion VFX - pull reaches everything it visibly sucks
    knockbackForce: 25,
    forceMode: 'pull',
    speed: 80,
    gravity: false,
    bodyRadius: 0.5,
    hitMin: 0,
    hitMax: 0.25, // belt rule: the throw is a physical shell, not a wake - the pull AOE is the payoff after contact
    hitGrow: 2,
    maxLifetime: 12, // same sail time as the launcher's disc
    beltThrow: true,
  },
  [WeaponType.BeltDisc]: {
    sfxKey: WeaponType.Disc, vmKey: WeaponType.Disc,
    fireInterval: 1,
    airtimeScale: true,
    // Belt disc: the plain push variant - same flight/damage, knocks back.
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 10,
    knockbackForce: 25,
    forceMode: 'push',
    speed: 80,
    gravity: false,
    bodyRadius: 0.5,
    hitMin: 0,
    hitMax: 0.25,
    hitGrow: 2,
    maxLifetime: 12,
    beltThrow: true,
  },
  [WeaponType.Grenade]: {
    aimAxis: 'arcJudge',
    fireInterval: 1,
    directDamage: 50,
    aoeDamage: 20,
    aoeRadius: 13,
    knockbackForce: 35,
    forceMode: 'push',
    speed: 40,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0,
    hitMax: 0.25, // belt rule - and it phases through bodies anyway
    hitGrow: 2,
    maxLifetime: 1.5, // THE fuse - the only trigger. Nothing else pops it.
    // armTime == fuse ⇒ the shell NEVER arms: bodies phase through and
    // dirt can't detonate it, for its whole flight. Same machinery the
    // mortar uses pre-arm, held open until the timer ends the shell.
    armTime: 1.5,
    terrainBounce: true,
    bounceRestitution: 0.45, // lobbed iron - thuds and rolls, doesn't skip
    bounceFriction: 0.75,
  },
  [WeaponType.Chaingun]: {
    aimAxis: 'track',
    fireInterval: 0.09,
    // Server-owned bloom cone: +0.001 then ×1.25 per slug (tight for the
    // first ~5, blows open to max by ~15 ≈ 1.4s of spray), decayed 0.6/s
    // once the trigger's been up an interval. Same math the client
    // predicts; the cone itself is seeded off shotId so a forged center
    // claim still draws a cone.
    bloomRate: 0.001,
    bloomExp: 1.25,
    bloomDecay: 0.6,
    bloomMax: 0.1,
    directDamage: 8, // ~89 dps at 11/s - below plasma (125) but hitscan-easy; 13 slugs to kill a player

    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 250,
    gravity: false,
    bodyRadius: 0.15,
    hitMin: 0,
    hitMax: 2, // forgiving wake - the dps is honest, so let the spray land like it feels
    hitGrow: 0.25, // full 1m proxy by ~125m - mid-range is where the spray lives
    maxLifetime: 1.5, // ~375m of reach - every other fast slug carries a fuse; without one remote replicas streak to the 10s backstop
  },
  [WeaponType.Mortar]: {
    aimAxis: 'arcJudge',
    fireInterval: 2,
    gib: true, tier: 'heavy',
    directDamage: 120,

    aoeDamage: 80,
    aoeRadius: 18,
    // Steep inner ring, thin outskirts: 100/80/40 across the 18m - a mortar
    // pays out on placement, not on carpeting (that's the MRV's job).
    aoeScales: [0.833, 0.667, 0.333],
    knockbackForce: 45,
    forceMode: 'push',
    speed: 80, // T:A Fusion Mortar / T2 Classic (~76) territory - at GRAVITY -28 the lob needs it
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.5, // area-denial tier: 0.5m wake cap - the 18m splash is the reach, not the proxy
    hitGrow: 2,
    maxLifetime: 12, // long lobs stay live - fuse only bounds desynced replicas
    armTime: 1.5, // T2 arming fuse - no point-blank body pops; bounces off
                // dirt until it cooks (client mortarConfig's canBounce rule)
    terrainBounce: true,
    bounceRestitution: 0.25, // mortars thud, not skip
    bounceFriction: 0.7,
  },
  [WeaponType.GrenadeLauncher]: {
    aimAxis: 'arcLead',
    fireInterval: 0.5,
    gib: true,
    directDamage: 50,
    aoeDamage: 20,
    aoeRadius: 12,
    knockbackForce: 35,
    forceMode: 'push',
    speed: 60,
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0,
    hitMax: 2, // tight proxy - bouncing shells shouldn't drag a huge wake
    hitGrow: 2,
    maxLifetime: 6, // fuse cap - a bouncing shell skitters a long way before the airburst
    armTime: 1, // bounce window only - dirt skips until cooked
    bodyArmTime: 0, // T2 GL: a body contact pops at ANY age - the arming
                    // fuse exists so shells skip, not so they pass through
    terrainBounce: true, // T2 GL core: skips off dirt, pops on bodies
    bounceRestitution: 0.55, // = client GL_BOUNCE_RESTITUTION
    bounceFriction: 0.7,     // = client GL_BOUNCE_FRICTION
  },
  [WeaponType.Flak]: {
    aimAxis: 'arcLead',
    fireInterval: 1.2,
    tier: 'medium',
    directDamage: 9,
    burst: 9, // one pull registers all shards at once // per shard - 9 shards ≈ 81 max
    pelletSpread: 0.1,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 90,
    gravity: true,
    bodyRadius: 0.12,
    hitMin: 0,
    hitMax: 1,
    hitGrow: 0.5,
    maxLifetime: 2,
    ttlJitter: 0.1, // shards scatter their airbursts - a synchronized pop reads as a single blob
    terrainBounce: true,
    bounceRestitution: 0.6, // = client FLAK_BOUNCE_RESTITUTION
    bounceFriction: 0.8,
    maxBounces: 3,          // shards die on the Nth terrain hit
  },
  [WeaponType.PlasmaCannon]: {
    aimAxis: 'track',
    fireInterval: 0.28,
    gib: true, tier: 'heavy',
    // PlasmaGun pool mechanic, smaller magazine: 10 rounds, regen 2×
    // interval while the trigger's cold - ~2.8s of full-rate fire.
    ammoCap: 10,
    ammoRegenMult: 2,
    directDamage: 45,

    aoeDamage: 25,
    aoeRadius: 5.5,
    knockbackForce: 20,
    forceMode: 'push',
    speed: 90,
    gravity: false,
    bodyRadius: 0.2,
    hitMin: 0,
    hitMax: 2, // tight proxy - the fat bolt is already generous
    hitGrow: 2,
    maxLifetime: 5, // ~450m flat - same fuse class as Disc; remote replicas otherwise streak forever
  },
  [WeaponType.PlasmaGun]: {
    aimAxis: 'track',
    fireInterval: 0.1,
    tier: 'medium',
    // Ammo pilot: 20-round pool regening at 2× the fire interval, paused
    // while the trigger's hot - a clean 2s full-rate burst, then the gun
    // trickles at half cadence once dry.
    ammoCap: 20,
    ammoRegenMult: 2,

    // Quake 2/3 plasma: rapid volley of fat bolts - chain-like cadence
    // (10/s, ~140dps) but a visible projectile you can dodge, so it
    // pays below chaingun's effective DPS vs movers and above vs track.
    directDamage: 14,
    aoeDamage: 4,
    aoeRadius: 2.5, // tiny pop - bolts sting, they don't splash
    knockbackForce: 8,
    forceMode: 'push',
    speed: 160,   // slower than chain slugs (250), fast enough to lead lightly
    gravity: false,
    bodyRadius: 0.32, // visibly chunky bolt - generous vs players
    hitMin: 0,
    hitMax: 1.2,
    hitGrow: 0.3,
    maxLifetime: 1.5, // ~240m of reach
  },
  [WeaponType.Railgun]: {
    aimAxis: 'snap',
    fireInterval: 1.5,
    tier: 'light',
    // Quake railgun: 60dmg slug at 400 m/s ≈ hitscan past ~200m - a
    // three-shot on mediums, not two (was dominant at range: 7/12 FFA
    // wins). Small AOE so near-misses still pop.
    directDamage: 60,
    aoeDamage: 20,
    aoeRadius: 6,
    knockbackForce: 35,
    forceMode: 'push',
    speed: 400,
    gravity: false,
    bodyRadius: 0.18,
    hitMin: 0,
    hitMax: 0.5, // tight - a rail is precision, not a wake
    hitGrow: 0.15, // fast ramp, no grace - full proxy by ~68m of travel
    maxLifetime: 1.2, // ~540m of reach
  },
  [WeaponType.Melee]: {
    fireInterval: 0.5,
    // Power punch: instant cone in front of the player. Ballistic fields inert;
    // aoeDamage/aoeRadius are the authoritative reach the server validates.
    directDamage: 0,
    aoeDamage: 55,
    aoeRadius: 3.2,
    knockbackForce: 40,
    forceMode: 'push',
    speed: 0,
    gravity: false,
    bodyRadius: 0,
    hitMin: 0,
    hitMax: 0,
    hitGrow: 0,
  },
  [WeaponType.Lightning]: {
    beam: true,
    aimAxis: 'track',
    fireInterval: 0.05,
    tier: 'light',
    // Hitscan beam - not a projectile; ballistic fields inert. Tick damage is
    // directDamage (~89 dps vs enemies - halved: 8dmg ticks were sawing
    // through targets in a blink); aoeDamage/aoeRadius validate the
    // per-tick blast claim the client sends for remote-player hits.
    directDamage: 4,
    aoeDamage: 2.5,
    aoeRadius: 1.6, // narrow shaft - tracking weapon, not a wake
    knockbackForce: 4, // the drag: a pull nudge per tick - it accrues at 22/s, keep it modest
    forceMode: 'pull',
    speed: 0,
    gravity: false,
    bodyRadius: 0,
    hitMin: 0,
    hitMax: 0,
    hitGrow: 0,
  },
  [WeaponType.Shocklance]: {
    beam: true,
    // T2 shocklance, first pass: a single hitscan zap on the pull-out
    // cycle - directDamage IS the bolt (no splash, no backstab yet).
    directDamage: 70,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 30,
    forceMode: 'push',
    speed: 0,
    gravity: false,
    bodyRadius: 0,
    hitMin: 0,
    hitMax: 0,
    hitGrow: 0,
    sidearm: true,
  },
  [WeaponType.Shotgun]: {
    aimAxis: 'track',
    fireInterval: 0.7,
    burst: 10, // one pull registers all pellets at once
    pelletSpread: 0.065,
    // Pump pellets: 10 × 5dmg ≈ 50 point-blank - a tighter cone than
    // flak's wide lob, so it's the mid-band scattergun to flak's doorway.
    // Fast slugs on a 0.4s fuse give mid-band reach - usable where flak's
    // lobbed shards scatter into nothing.
    directDamage: 5, // per pellet - 10 pellets ≈ 50 max
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 250,
    gravity: false,
    bodyRadius: 0.1,
    hitMin: 0,
    hitMax: 0.4,
    hitGrow: 0.1,
    maxLifetime: 0.4,
    sidearm: true,
  },
  [WeaponType.Cannon]: {
    aimAxis: 'arcLead',
    fireInterval: 1.1,
    gib: true, tier: 'medium',

    // Serious Sam cannonball: a big iron sphere that SKIPS off terrain
    // (client bounce config) and detonates on target contact or fuse.
    // The GL's rowdier bigger brother - trades shell count for presence.
    directDamage: 65,
    aoeDamage: 25,
    aoeRadius: 7, // mid of the arc family: gonne 6 < cannon 7 < basilisk 8
    knockbackForce: 40,
    forceMode: 'push',
    speed: 80,    // faster than GL's 55 - it skips far between bounces
    gravity: true,
    bodyRadius: 0.8, // HUGE - the comedy is the ball, not the damage
    hitMin: 0,
    hitMax: 2,    // proxy scaled to match the bigger ball
    hitGrow: 1.5,
    maxLifetime: 6, // skitters around until fuse or contact ends it
    terrainBounce: true,
    bounceRestitution: 1, // perfectly elastic - loses nothing off dirt
    bounceFriction: 1, // tangential kept in full: zero friction
    firstBounceVelScale: 0.5, // the first skip SLAMS - half the speed dies on landing #1; later skips stay elastic
    fuseAfterBounce: 0.25, // first skip starts a 0.25s cook-off - the ball detonates where it lands, not 6s later
    // Bounce/lodge SHELVED for now - maxBounces 0 detonates on first
    // dirt contact. The skip fields (and lodgeBounce support) stay so
    // either behavior can be re-tried by removing this line.
    maxBounces: 0,
  },
  [WeaponType.Gonne]: {
    fireInterval: 1,
    gib: true, tier: 'light',
    // The light frame's member of the 80 m/s gravity-arc family - same
    // shell economics as the cannon (a flavored reskin, not a new
    // weapon): same damage, same splash, same cadence, same arc. The
    // difference is the gun: a stubby wrought-iron handgonne instead of a
    // naval bore.
    directDamage: 60, // lightest ball, lightest payload: gonne 60 < cannon 65 < basilisk 70
    aoeDamage: 25,
    aoeRadius: 6, // smallest burst of the family - the handgonne's little charge
    knockbackForce: 40,
    forceMode: 'push',
    speed: 80,
    gravity: true,
    bodyRadius: 0.53, // ~2/3 the cannonball - the handgonne's smaller ball, honest hitbox and mesh both
    hitMin: 0,
    hitMax: 2,
    hitGrow: 1.5,
    maxLifetime: 6,
    terrainBounce: true,
    bounceRestitution: 1,
    bounceFriction: 1,
    firstBounceVelScale: 0.5,
    fuseAfterBounce: 0.25,
    maxBounces: 0, // bounce/lodge shelved - contact pop for now, same as the cannon
  },
  [WeaponType.Basilisk]: {
    fireInterval: 1.2,
    gib: true, tier: 'heavy',
    // The heavy frame's member of the 80 m/s gravity-arc family - same
    // shell economics as the cannon/gonne (a flavored reskin, not a
    // new weapon). The huge-bore bronze gun is cosmetic; the Bombard
    // remains the heavy's UNIQUE weapon (140 direct, no AoE, crumbles).
    directDamage: 70, // biggest bore, biggest payload: gonne 60 < cannon 65 < basilisk 70
    aoeDamage: 25,
    aoeRadius: 8, // biggest burst of the family - the heavy bore gets the biggest pop
    knockbackForce: 40,
    forceMode: 'push',
    speed: 80,
    gravity: true,
    bodyRadius: 0.8,
    hitMin: 0,
    hitMax: 2,
    hitGrow: 1.5,
    maxLifetime: 6,
    terrainBounce: true,
    bounceRestitution: 1,
    bounceFriction: 1,
    firstBounceVelScale: 0.5,
    fuseAfterBounce: 0.25,
    maxBounces: 0, // bounce/lodge shelved - contact pop for now, same as the cannon
  },
  [WeaponType.MissileLauncher]: {
    aimAxis: 'arcLead',
    fireInterval: 2.5,
    gib: true, tier: 'heavy',
    // RPG-style missile: flat trajectory, slower than the Bolt Launcher
    // but not free to dodge (65 m/s - the 48 shell was readable-in-flight
    // to the point of never connecting at range) in exchange for the
    // biggest non-mortar blast. The Tribes/Quake rocket niche the Bolt
    // Launcher never filled.
    directDamage: 90,
    aoeDamage: 35,
    aoeRadius: 14, // big - but under mortar's 18
    // Splash bands on the 90 direct: 50/35/20 - a real gradient instead
    // of a cliff; mid-ring grazes wound instead of deleting half a bar.
    aoeScales: [0.556, 0.389, 0.222],
    knockbackForce: 30, // rocket-jump tier - the tool IS the movement; sits at BLAST_IMPULSE_MAX so point-blank stays the intended apex
    forceMode: 'push',
    speed: 60, // 48 was deliberately-dodgeable; EV-aim + ~60m/s closed the gap (K/D 0.65->0.72 vs CG forced) - still slower than BoltLauncher (120)
    gravity: false,
    bodyRadius: 0.35,
    hitMin: 0,
    hitMax: 0.5, // area-denial tier: 0.5m wake cap - the 14m splash is the reach, not the proxy
    hitGrow: 0.4,
    maxLifetime: 6, // ~290m of flat reach
  },
  [WeaponType.Howitzer]: {
    aimAxis: 'arcJudge',
    fireInterval: 3,
    gib: true, tier: 'heavy',
    sfxKey: WeaponType.Mortar, vmKey: WeaponType.Mortar,
    // Siege mortar: a 5-charge drum on the plasma pool - one round back
    // per 6s (interval ×2), so sustained siege is 10rpm, not a carpet.
    ammoCap: 5,
    ammoRegenMult: 2,
    ammoAlwaysRegen: true, // charges accrue nonstop - the drum IS the reload
    // Shorter reach than the mortar (60 vs 80) traded for a bigger boom;
    // the long 3s arming fuse bars close work entirely - the shell is
    // dead dirt inside ~180m of flat arc.
    directDamage: 150,
    aoeDamage: 100,
    aoeRadius: 22,
    aoeScales: [0.833, 0.667, 0.333], // same steep banding as the mortar
    knockbackForce: 50,
    forceMode: 'push',
    speed: 60,
    gravity: true,
    // The fun: violent recoil kicks the shooter opposite the shot. Fired
    // upward off flat ground the kick plants you for fall damage; fired
    // airborne it's a movement tool. Anti-fall perk is the pairing.
    recoilImpulse: 30,
    groundedOnly: true, // deploy artillery - no air, no ski, or it's a jump pad
    bodyRadius: 0.35,
    hitMin: 0,
    hitMax: 0.5,
    hitGrow: 2,
    maxLifetime: 15, // longer lobs than the mortar's fuse class
    armTime: 3, // dead-fuse window IS the close-range bar
    terrainBounce: true,
    bounceRestitution: 0.25,
    bounceFriction: 0.7,
  },
  [WeaponType.RocketLauncher]: {
    aimAxis: 'arcLead',
    fireInterval: 1,
    gib: true, airtimeScale: true, aoeBonus: true,
    sfxKey: WeaponType.BoltLauncher, vmKey: WeaponType.RocketLauncher,
    // The universal rocket: Bolt Launcher stats minus the arc - flat
    // 120 m/s bolt anyone can carry (every class, no tier lock).
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 8,
    knockbackForce: 28,
    forceMode: 'push',
    speed: 120,
    gravity: false,
    bodyRadius: 0.18,
    hitMin: 0,
    hitMax: 8,
    hitGrow: 2,
    maxLifetime: 12,
  },
  [WeaponType.FastDiscLauncher]: {
    aimAxis: 'arcLead',
    fireInterval: 1.2,
    gib: true, airtimeScale: true, aoeBonus: true,
    sfxKey: WeaponType.Disc, vmKey: WeaponType.Disc,
    // The fast disc: exact mirror of the benched universal rocket -
    // same flat 120 m/s flight and damage, only the silhouette changes.
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 5,
    knockbackForce: 28,
    forceMode: 'push',
    speed: 120,
    gravity: false,
    bodyRadius: 0.18,
    hitMin: 0,
    hitMax: 8,
    hitGrow: 2,
    maxLifetime: 12,
  },
  [WeaponType.Pistol]: {
    aimAxis: 'snap',
    fireInterval: 0.22,

    // Hold-out sidearm: fast flat slug, modest damage - the panic button
    // when the primary is dry or wrong for the range.
    directDamage: 8,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 4,
    forceMode: 'push',
    speed: 250,
    gravity: false,
    bodyRadius: 0.12,
    hitMin: 0,
    hitMax: 0.5,
    hitGrow: 0.1,
    maxLifetime: 0.6,
    sidearm: true,
  },
  [WeaponType.Revolver]: {
    aimAxis: 'snap',
    fireInterval: 0.6,

    // Hand cannon: slow cadence, heavy single slug.
    directDamage: 20,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 8,
    forceMode: 'push',
    speed: 250,
    gravity: false,
    bodyRadius: 0.14,
    hitMin: 0,
    hitMax: 0.5,
    hitGrow: 0.1,
    maxLifetime: 0.5,
    sidearm: true,
  },
  [WeaponType.Blaster]: {
    aimAxis: 'snap',

    // T1 blaster - jet-energy sidearm: 10 energy per pull, 30 flat on
    // contact. Heavier than the pistol slug per hit, but the magazine IS
    // the jet tank - spamming it costs the climb out of trouble.
    directDamage: 30,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 6,
    forceMode: 'push',
    speed: 180,
    gravity: false,
    bodyRadius: 0.18,
    hitMin: 0,
    hitMax: 0.5,
    hitGrow: 0.1,
    maxLifetime: 0.8, // ~145m reach - the bolt fades before range drop matters
    energyCost: 10,
    fireInterval: 0.3,
    sidearm: true,
  },
  [WeaponType.Sticky]: {
    aimAxis: 'arcJudge',
    fireInterval: 0.6,
    gib: true,
    // Sticky launcher (T2): glue bomb - sticks where it lands, pops on a
    // 3s fuse. The CHAIN is the weapon: a detonation cooks every other
    // live sticky in its radius, and at 0.6s cadence a player can stack 5
    // before the first fuse pops - so a cluster is one big overlapping
    // overlapping blast, not three weak pops.
    directDamage: 80,
    aoeDamage: 35,
    aoeRadius: 11,
    knockbackForce: 40,
    forceMode: 'push',
    speed: 80,
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.25, // proxy barely wider than the shell - sticks on real contact, not a 2m wake
    hitGrow: 0.5,
    maxLifetime: 3, // THE fuse - 0.8s rate ⇒ ~3 bombs live per shooter
    stick: true,
  },
  [WeaponType.BeltSticky]: {
    fireInterval: 1,
    // Belt twin of the glue bomb - same payload, hand-thrown lob. The
    // slow arc is the COMBO enabler: it hangs long enough for your own
    // shell to catch up and swallow it (stats.rides). Own weaponType so
    // the wire tells toss from launcher - the shared type used to make
    // belt throws free (server couldn't charge the nugget).
    directDamage: 45,
    aoeDamage: 35,
    aoeRadius: 11,
    knockbackForce: 40,
    forceMode: 'push',
    speed: 20,      // a third of the launcher's muzzle - hangs catchable
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.25,
    hitGrow: 0.5,
    maxLifetime: 3.5, // a beat longer than the launcher - the lob needs hang time to BE caught
    stick: true,
    rides: true,
  },
  [WeaponType.ClusterBomb]: {
    aimAxis: 'arcJudge',
    fireInterval: 1,
    // Belt cluster: a fuse bomb whose pop is only the carrier - the real
    // damage is the bomblet scatter it releases (each claims with
    // ClusterBomblet stats, so the parent's radius stays honest).
    directDamage: 30,
    aoeDamage: 15,
    aoeRadius: 8,
    knockbackForce: 12, // the pop is only the delivery - the payload shoves
    forceMode: 'push',
    speed: 40,
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.25, // near-contact only - an 8m proxy popped the carrier on anything nearby
    hitGrow: 2,
    maxLifetime: 1.6, // fuse pop releases the bomblets
    fuseOnly: true,   // bodies don't pop it - an impact cluster is a
                    // strictly-better grenade (same logic as MRV). Terrain
                    // and walls still stop it - that's the ground-pop lane.
    cluster: { count: 5, radius: 9 }, // bomblet scatter footprint around the pop
  },
  [WeaponType.ClusterBomblet]: {
    // Child charge - small pop, small radius; count is the weapon.
    directDamage: 15,
    aoeDamage: 12,
    aoeRadius: 6,
    knockbackForce: 7, // popcorn pop, not a launcher - 5 stacked ≈ a rocket's worth
    forceMode: 'push',
    speed: 0, // spawned mid-air by the carrier, never muzzle-fired
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0,
    hitMax: 0.25, // bomblets must LAND - a fat proxy pops the rain mid-air
    hitGrow: 1,
    maxLifetime: 1.1,
  },
  [WeaponType.Javelin]: {
    aimAxis: 'snap',
    fireInterval: 1,
    airtimeScale: true,
    // Thrown dart: near-flat long throw, heavy single-target pierce.
    // No splash - the skill shot IS the reward.
    directDamage: 60,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 26, // the stagger IS the hit feedback - a 60dmg spear shoves
    forceMode: 'push',
    speed: 120,  // bolt-launcher velocity - a thrown spear shouldn't lob
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0,
    hitMax: 0.25, // belt rule - a thrown spear skewers on the shaft, not a wake
    hitGrow: 0.2,
    maxLifetime: 12, // ~1.4km - spear prayers stay live; fuse only bounds desynced replicas
  },
  [WeaponType.ImpactGrenade]: {
    aimAxis: 'arcLead',
    fireInterval: 1,
    // Contact-fused blast nade: flies flat and far, pops on ANY touch,
    // medium-high damage in a tight envelope - a real kill tool whose
    // shove is the bonus, not the payload (the CONC carries the strip).
    directDamage: 60,
    aoeDamage: 20,
    aoeRadius: 5,
    knockbackForce: 45, // biggest shove in the belt
    forceMode: 'push',
    speed: 60,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0,
    hitMax: 0.25, // belt rule: the contact pop needs real contact, not a 6m wake
    hitGrow: 1.5,
    maxLifetime: 4, // contact usually pops it first
  },
  [WeaponType.Concussion]: {
    // T2 concussion grenade: the blast is a STRIP, not a kill - small
    // sting inside a wide envelope, a heavy shove, the flag pops loose,
    // and the victim's jet tank takes a bite (CONC_JET_DRAIN). Pure fuse
    // bomb: never arms, so bodies phase through and dirt only bounces it.
    directDamage: 15,
    aoeDamage: 8,
    aoeRadius: 9,
    knockbackForce: 55,
    forceMode: 'push',
    speed: 40,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0,
    hitMax: 0.25, // belt rule - and it phases through bodies anyway
    hitGrow: 2,
    maxLifetime: 1.5,
    armTime: 1.5, // never arms - same never-pops-on-contact contract as Grenade
    terrainBounce: true,
    bounceRestitution: 0.5,
    bounceFriction: 0.7,
    beltThrow: true,
    fireInterval: 1,
  },
  [WeaponType.RemoteRailgun]: {
    aimAxis: 'snap',
    fireInterval: 1,
    // Belt capacitor slug: 0.4s of readable lob, then a railgun-class beam
    // down its velocity line and a pop at whatever the beam touches. The
    // slug itself can also contact-pop before discharge like an impact nade.
    directDamage: 70,
    aoeDamage: 25,
    aoeRadius: 7,
    knockbackForce: 35,
    forceMode: 'push',
    speed: 40,    // slower lob - a readable cap-to-discharge window
    inherit: 0,   // no velocity inheritance: the rail discharges down the
                  // slug's velocity line, so inherited speed would aim the
                  // hitscan somewhere the thrower never pointed
    gravity: false, // flat flight: the ray tracks the throw line
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.25, // belt rule - the reach is the beam, not a wake
    hitGrow: 0.3,
    maxLifetime: 4, // intercept before discharge → plain impact pop
    rayDelay: 0.4,
    rayRange: 160,
  },
};
import { WEAPONS_B } from './weaponRowsB.ts';
Object.assign(WEAPONS, WEAPONS_B);
