// Per-weapon stat table — the data half of weapons.ts (types/helpers
// stay there; this file is one record, nothing else). Do not hand-edit
// semantics lightly: shared sims, bots and HUDs all read these rows.

export enum WeaponType {
  BoltLauncher = 0, // the prototype bolt launcher — was 'Rocket'; id kept for wire compat
  Disc = 1,
  Grenade = 2, // thrown fuse bomb (F key) — distinct from the launcher
  Chaingun = 3,
  Mortar = 4,
  GrenadeLauncher = 5,
  Flak = 6,
  PlasmaCannon = 7, // the fat slow T1/T2 bolt — was 'Plasma'; id kept for wire compat
  Slam = 8, // skill ground-slam — not a projectile, but lands as an AOE
  Railgun = 9,
  Melee = 10, // E-key punch — not a projectile; aoe fields drive server validation
  DiscPull = 11, // belt disc (C) — the implosion variant; launcher disc pushes
  Lightning = 12, // Quake LG: hitscan beam, ticks ~22/s; aoe fields validate the pin-blast
  Shotgun = 13, // pellet burst — tighter cone than flak, works to mid range
  Cannon = 14, // Serious Sam cannonball — fast, fat, skips off terrain, pops on contact
  RocketLauncher = 15, // classic RPG: slow straight-flying missile, big boom, rocket-jump friendly
  Pistol = 16,        // hold-out sidearm (G): quick semi-auto slug, no splash
  Revolver = 17,      // hold-out sidearm (T): slow hand-cannon slug, no splash
  Sticky = 18,        // sticky launcher: lobbed bomb that glues to surface/player, 3s fuse, chain-detonates
  ClusterBomb = 19,   // belt throw: fuse pop scatters bomblets that each detonate
  Javelin = 20,       // belt throw: fast flat dart — direct damage only, no splash
  ImpactGrenade = 21, // belt throw: flat arc, contact pop, low damage, big shove
  ClusterBomblet = 22,// spawned by ClusterBomb detonation — never fired directly
  PlasmaGun = 23,     // Quake-style rapid plasma: fast cadence, mid-speed fat bolt
  RemoteRailgun = 24, // belt throw: slug discharges a hitscan rail mid-flight, pops at the hit point
  Sprinkler = 25,     // plasma hose: rapid stream of arced bolts with cone spread
  Repair = 26,        // repair-tool sidearm: short beam that heals deployables, overheal → armor
  ArmorGrenade = 27,  // belt throw: mid blast that plates every player + creature it catches
  MRVLauncher = 28,   // mortar's counterpart: bouncing carrier shell airbursts into bomblets (MRV — one volley, not MIRV)
  MRVBomblet = 29,    // spawned by MRVLauncher detonation — contact pop, never fired
  HealBeam = 30,      // support beam: hitscan that HEALS the friendly target it pins — jet energy is the ammo
  HealGrenade = 31,   // belt throw: small blast, strong heal for allies caught; enemies eat the sting + shove
  ProxyGrenade = 32,  // belt throw: 1s fuse, proxy bubble inflating to 4m — toss-and-zone pop
  SatchelCharge = 33,    // belt throw: infiltrator satchel — glues to surface/player, 4s fuse, objective-killer blast
  Concussion = 34,       // belt throw: T2 conc — fuse bomb, tiny sting, huge shove, strips the flag and drains jets
  Bombard = 35,          // heavy siege slug: the cannon's bigger brother — biggest direct hit in the game, NEVER explodes, crumbles on any contact
  BeltSticky = 36,       // belt throw: hand-lobbed glue bomb — same payload as the launcher, but slow enough to be CAUGHT: a same-owner shell picks it up mid-flight and it rides dead-center to the target (Painkiller combo)
}

export interface WeaponStats {
  /** Damage on direct hit (server `shot` handler) */
  directDamage: number;
  /** Splash damage at blast center */
  aoeDamage: number;
  /** Splash radius (m) — 0 = no splash */
  aoeRadius: number;
  /** Per-weapon splash band fractions of the direct hit (inner/mid/outer
   *  thirds of aoeRadius). Absent = global AOE_BAND_SCALES (0.75/0.5/0.25). */
  aoeScales?: readonly [number, number, number];
  /** Impulse magnitude at blast center (m/s) */
  knockbackForce: number;
  /** 'pull' = implosion toward center (disc) */
  forceMode: 'push' | 'pull';
  /** Muzzle speed (m/s) — before 50% player-velocity inheritance */
  speed: number;
  /** Whether world gravity (-28 m/s²) bends the trajectory — boolean by
   *  design: physics is physics, per-weapon fudge factors read as fake. */
  gravity: boolean;
  /** Core hitbox radius (m) — a hit inside this counts as direct */
  bodyRadius: number;
  /** Wake proxy hitbox floor (m) at spawn */
  hitMin: number;
  /** Wake proxy hitbox ceiling (m) once fully grown */
  hitMax: number;
  /** Seconds from spawn for the wake to reach hitMax */
  hitGrow: number;
  /** Fuse self-detonate time (s); 0/undefined = terrain/target contact only */
  maxLifetime?: number;
  /** Spawn claims allowed per WEAPON_FIRE_INTERVAL_S window (fan weapons:
   *  one pull registers every pellet at once). Default 1. */
  burst?: number;
  /** Cone slope factor for a `burst` fan — the golden-angle offsets each
   *  pellet's dir by up to this much (0.10 ≈ flak's wide shard cone,
   *  0.035 ≈ the pump's tight spray). Only read when burst > 1. */
  pelletSpread?: number;
  /** Per-shot TTL spread: each projectile's fuse scales by ±this fraction,
   *  seeded from its projectileId so server and client replicas pop at the
   *  same age. A burst of shards should raggedly fade, not pop in unison. */
  ttlJitter?: number;
  /** Cluster carrier — on detonation the SERVER scatters `count` bomblet
   *  blasts (ClusterBomblet stats) inside `radius` of the impact point.
   *  Client bomblets are visual-only: they never claim damage, so remote
   *  hits stay server-authoritative. */
  cluster?: { count: number; radius: number };
  /** Body contact doesn't detonate — the shell flies through players and
   *  creatures (MRV carrier: a contact pop would make it a fast mortar;
   *  the fuse airburst IS the attack). Terrain, walls, and shield domes
   *  still stop it. Both ends read this so the sim stays authoritative. */
  fuseOnly?: boolean;
  /** T2 mortar arming delay: player/creature contact before this age does
   *  NOT detonate — the shell phases through bodies until the fuse arms.
   *  Terrain/wall/shield contact still applies (client bounces, server
   *  pops) — the arm time gates the KILL, not the landing. */
  armTime?: number;
  /** Bodies phase through until this age (defaults to armTime). Set to 0
   *  when a shell bounces off dirt yet pops on body contact at ANY age —
   *  the T2 grenade launcher: no arming window on players, only on dirt. */
  bodyArmTime?: number;
  /** Mid-flight hitscan discharge (remote railgun): at `rayDelay` seconds
   *  the projectile fires a beam along its velocity and dies at the hit
   *  point (or at rayRange on a miss). The server reach check adds
   *  rayRange to the legal flight distance once airtime passes rayDelay. */
  rayDelay?: number;
  rayRange?: number;
  /** Terrain contact BOUNCES instead of detonating (thrown fuse bombs:
   *  the 1.5s timer is the only trigger). The server reflects the shell
   *  off the heightfield normal and keeps it live until the fuse pops —
   *  clients replay the same bounce in their replica sim. */
  terrainBounce?: boolean;
  /** Shared bounce constants — server sim and client config read the
   *  same numbers so the replica arc matches the authoritative one. */
  bounceRestitution?: number; // normal velocity kept per bounce
  bounceFriction?: number;    // tangential velocity kept per bounce
  maxBounces?: number;        // die on the Nth terrain hit (flak shards); unset = bounce until fuse
  /** First terrain bounce clamps the remaining fuse to this many seconds
   *  — a skip becomes a short cook-off instead of free ricochet time. */
  fuseAfterBounce?: number;
  /** T2 glue bomb: contact STOPS the shell instead of detonating — it
   *  freezes on terrain/walls, glues onto a player it touches (riding
   *  them until the fuse pops), and only `maxLifetime` triggers the
   *  blast. A detonation cooks siblings in radius — the stack is the
   *  weapon. Both ends read this so a stuck bomb looks and kills
   *  identically. */
  stick?: boolean;
  /** Rideable payload (belt sticky): while airborne, a same-owner
   *  projectile passing inside RIDE_CATCH_R swallows it — it stops
   *  simming, centers on the host, and detonates where the host dies.
   *  Both ends run the same catch or replicas unride. */
  rides?: boolean;
}

/** Catch radius for the belt-sticky combo — shared so the server and
 *  the client replica attach on the same tick. Tight on purpose: this
 *  is an aimed skill shot, not a vacuum. */
export const RIDE_CATCH_R = 1;

/** Explosion VFX dome = aoeRadius × this — damage always reaches a bit past
 *  the visual edge (covers the shock ring), and the two can never drift. */
export const WEAPONS: Record<number, WeaponStats> = {
  [WeaponType.BoltLauncher]: {
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 8, // ~1.3× the VFX dome — damage reaches the ring's edge
    knockbackForce: 28,
    forceMode: 'push',
    speed: 120,
    gravity: true,
    bodyRadius: 0.18,
    hitMin: 0,
    hitMax: 8,
    hitGrow: 2,
    maxLifetime: 12, // ~1.4km — effectively "flies until it lands"; the fuse only exists so a bugged remote replica can't streak forever
  },
  [WeaponType.Disc]: {
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 10,
    knockbackForce: 45, // THE disc-jump weapon — strongest launcher shove (rocket=40, MRV=45)
    forceMode: 'push', // launcher disc knocks back like everything else
    speed: 80,
    gravity: false,
    bodyRadius: 0.5,
    hitMin: 0.3,
    hitMax: 8,
    hitGrow: 2,
    maxLifetime: 12, // ~960m — long prayers stay live; fuse only bounds desynced replicas
  },
  [WeaponType.DiscPull]: {
    // Belt disc (C): the implosion — pulls targets toward the blast.
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 10, // slightly exceeds the 8m Implosion VFX — pull reaches everything it visibly sucks
    knockbackForce: 25,
    forceMode: 'pull',
    speed: 80,
    gravity: false,
    bodyRadius: 0.5,
    hitMin: 0,
    hitMax: 0.25, // belt rule: the throw is a physical shell, not a wake — the pull AOE is the payoff after contact
    hitGrow: 2,
  },
  [WeaponType.Grenade]: {
    directDamage: 50,
    aoeDamage: 20,
    aoeRadius: 13,
    knockbackForce: 35,
    forceMode: 'push',
    speed: 40,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0,
    hitMax: 0.25, // belt rule — and it phases through bodies anyway
    hitGrow: 2,
    maxLifetime: 1.5, // THE fuse — the only trigger. Nothing else pops it.
    // armTime == fuse ⇒ the shell NEVER arms: bodies phase through and
    // dirt can't detonate it, for its whole flight. Same machinery the
    // mortar uses pre-arm, held open until the timer ends the shell.
    armTime: 1.5,
    terrainBounce: true,
    bounceRestitution: 0.45, // lobbed iron — thuds and rolls, doesn't skip
    bounceFriction: 0.75,
  },
  [WeaponType.Chaingun]: {
    directDamage: 8, // ~89 dps at 11/s — below plasma (125) but hitscan-easy; 13 slugs to kill a player

    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 250,
    gravity: false,
    bodyRadius: 0.15,
    hitMin: 0,
    hitMax: 2, // forgiving wake — the dps is honest, so let the spray land like it feels
    hitGrow: 0.25, // full 1m proxy by ~125m — mid-range is where the spray lives
    maxLifetime: 1.5, // ~375m of reach — every other fast slug carries a fuse; without one remote replicas streak to the 10s backstop
  },
  [WeaponType.Mortar]: {
    directDamage: 120,

    aoeDamage: 80,
    aoeRadius: 18,
    // Steep inner ring, thin outskirts: 100/80/40 across the 18m — a mortar
    // pays out on placement, not on carpeting (that's the MRV's job).
    aoeScales: [0.833, 0.667, 0.333],
    knockbackForce: 45,
    forceMode: 'push',
    speed: 60,
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.5, // area-denial tier: 0.5m wake cap — the 18m splash is the reach, not the proxy
    hitGrow: 2,
    maxLifetime: 12, // long lobs stay live — fuse only bounds desynced replicas
    armTime: 1.5, // T2 arming fuse — no point-blank body pops; bounces off
                // dirt until it cooks (client mortarConfig's canBounce rule)
    terrainBounce: true,
    bounceRestitution: 0.25, // mortars thud, not skip
    bounceFriction: 0.7,
  },
  [WeaponType.GrenadeLauncher]: {
    directDamage: 50,
    aoeDamage: 20,
    aoeRadius: 13,
    knockbackForce: 35,
    forceMode: 'push',
    speed: 60,
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0,
    hitMax: 2, // tight proxy — bouncing shells shouldn't drag a huge wake
    hitGrow: 2,
    maxLifetime: 6, // fuse cap — a bouncing shell skitters a long way before the airburst
    armTime: 1, // bounce window only — dirt skips until cooked
    bodyArmTime: 0, // T2 GL: a body contact pops at ANY age — the arming
                    // fuse exists so shells skip, not so they pass through
    terrainBounce: true, // T2 GL core: skips off dirt, pops on bodies
    bounceRestitution: 0.55, // = client GL_BOUNCE_RESTITUTION
    bounceFriction: 0.7,     // = client GL_BOUNCE_FRICTION
  },
  [WeaponType.Flak]: {
    directDamage: 9,
    burst: 9, // one pull registers all shards at once // per shard — 9 shards ≈ 81 max
    pelletSpread: 0.1,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 90,
    gravity: true,
    bodyRadius: 0.12,
    hitMin: 0,
    hitMax: 2,
    hitGrow: 0.5,
    maxLifetime: 2,
    ttlJitter: 0.1, // shards scatter their airbursts — a synchronized pop reads as a single blob
    terrainBounce: true,
    bounceRestitution: 0.6, // = client FLAK_BOUNCE_RESTITUTION
    bounceFriction: 0.8,
    maxBounces: 3,          // shards die on the Nth terrain hit
  },
  [WeaponType.PlasmaCannon]: {
    directDamage: 45,

    aoeDamage: 25,
    aoeRadius: 5.5,
    knockbackForce: 20,
    forceMode: 'push',
    speed: 90,
    gravity: false,
    bodyRadius: 0.2,
    hitMin: 0,
    hitMax: 2, // tight proxy — the fat bolt is already generous
    hitGrow: 2,
    maxLifetime: 5, // ~450m flat — same fuse class as Disc; remote replicas otherwise streak forever
  },
  [WeaponType.PlasmaGun]: {

    // Quake 2/3 plasma: rapid volley of fat bolts — chain-like cadence
    // (10/s, ~140dps) but a visible projectile you can dodge, so it
    // pays below chaingun's effective DPS vs movers and above vs track.
    directDamage: 14,
    aoeDamage: 4,
    aoeRadius: 2.5, // tiny pop — bolts sting, they don't splash
    knockbackForce: 8,
    forceMode: 'push',
    speed: 160,   // slower than chain slugs (250), fast enough to lead lightly
    gravity: false,
    bodyRadius: 0.32, // visibly chunky bolt — generous vs players
    hitMin: 0,
    hitMax: 1.2,
    hitGrow: 0.3,
    maxLifetime: 1.5, // ~240m of reach
  },
  [WeaponType.Railgun]: {
    // Quake railgun: 60dmg slug at 450 m/s ≈ hitscan past ~200m — a
    // three-shot on mediums, not two (was dominant at range: 7/12 FFA
    // wins). Small AOE so near-misses still pop.
    directDamage: 60,
    aoeDamage: 20,
    aoeRadius: 6,
    knockbackForce: 35,
    forceMode: 'push',
    speed: 450,
    gravity: false,
    bodyRadius: 0.18,
    hitMin: 0,
    hitMax: 0.5, // tight — a rail is precision, not a wake
    hitGrow: 0.15, // fast ramp, no grace — full proxy by ~68m of travel
    maxLifetime: 1.2, // ~540m of reach
  },
  [WeaponType.Melee]: {
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
    // Hitscan beam — not a projectile; ballistic fields inert. Tick damage is
    // directDamage (~89 dps vs enemies — halved: 8dmg ticks were sawing
    // through targets in a blink); aoeDamage/aoeRadius validate the
    // per-tick blast claim the client sends for remote-player hits.
    directDamage: 4,
    aoeDamage: 2.5,
    aoeRadius: 1.6, // narrow shaft — tracking weapon, not a wake
    knockbackForce: 4, // the drag: a pull nudge per tick — it accrues at 22/s, keep it modest
    forceMode: 'pull',
    speed: 0,
    gravity: false,
    bodyRadius: 0,
    hitMin: 0,
    hitMax: 0,
    hitGrow: 0,
  },
  [WeaponType.Shotgun]: {
    burst: 10, // one pull registers all pellets at once
    pelletSpread: 0.065,
    // Pump pellets: 10 × 7dmg ≈ 70 point-blank — a tighter cone than
    // flak's wide lob, so it's the mid-band scattergun to flak's doorway.
    // Fast slugs on a 0.4s fuse give mid-band reach — usable where flak's
    // lobbed shards scatter into nothing.
    directDamage: 7, // per pellet — 10 pellets ≈ 70 max
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
  },
  [WeaponType.Cannon]: {

    // Serious Sam cannonball: a big iron sphere that SKIPS off terrain
    // (client bounce config) and detonates on target contact or fuse.
    // The GL's rowdier bigger brother — trades shell count for presence.
    directDamage: 70,
    aoeDamage: 25,
    aoeRadius: 10,
    knockbackForce: 40,
    forceMode: 'push',
    speed: 80,    // faster than GL's 55 — it skips far between bounces
    gravity: true,
    bodyRadius: 0.8, // HUGE — the comedy is the ball, not the damage
    hitMin: 0,
    hitMax: 2,    // proxy scaled to match the bigger ball
    hitGrow: 1.5,
    maxLifetime: 6, // skitters around until fuse or contact ends it
    terrainBounce: true,
    bounceRestitution: 1, // perfectly elastic — loses nothing off dirt
    bounceFriction: 1, // tangential kept in full: zero friction
    fuseAfterBounce: 0.5, // first skip starts a 0.5s cook-off — the ball detonates where it lands, not 6s later
  },
  [WeaponType.RocketLauncher]: {
    // RPG-style missile: flat trajectory, slower than the Bolt Launcher
    // but not free to dodge (65 m/s — the 48 shell was readable-in-flight
    // to the point of never connecting at range) in exchange for the
    // biggest non-mortar blast. The Tribes/Quake rocket niche the Bolt
    // Launcher never filled.
    directDamage: 90,
    aoeDamage: 35,
    aoeRadius: 14, // big — but under mortar's 18
    // Steep inner ring like the mortar's: the band data says RL's kills
    // all come from placement hits while mid-ring grazes wound and shove
    // survivors clear. 75/60/30 instead of 67/45/22 — the blast pays for
    // landing near feet, not for being big.
    aoeScales: [0.833, 0.667, 0.333],
    knockbackForce: 30, // rocket-jump tier — the tool IS the movement; sits at BLAST_IMPULSE_MAX so point-blank stays the intended apex
    forceMode: 'push',
    speed: 60, // 48 was deliberately-dodgeable; EV-aim + ~60m/s closed the gap (K/D 0.65->0.72 vs CG forced) — still slower than BoltLauncher (120)
    gravity: false,
    bodyRadius: 0.35,
    hitMin: 0,
    hitMax: 0.5, // area-denial tier: 0.5m wake cap — the 14m splash is the reach, not the proxy
    hitGrow: 0.4,
    maxLifetime: 6, // ~290m of flat reach
  },
  [WeaponType.Pistol]: {

    // Hold-out sidearm: fast flat slug, modest damage — the panic button
    // when the primary is dry or wrong for the range.
    directDamage: 14,
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
  },
  [WeaponType.Revolver]: {

    // Hand cannon: three hits kill — slow cadence, heavy single slug.
    directDamage: 34,
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
  },
  [WeaponType.Sticky]: {
    // Sticky launcher (T2): glue bomb — sticks where it lands, pops on a
    // 3s fuse. The CHAIN is the weapon: a detonation cooks every other
    // live sticky in its radius, and at 0.8s cadence a player can stack 3
    // before the first fuse pops — so a cluster is one triple-strength
    // overlapping blast, not three weak pops.
    directDamage: 45,
    aoeDamage: 35,
    aoeRadius: 11,
    knockbackForce: 40,
    forceMode: 'push',
    speed: 60,
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.25, // proxy barely wider than the shell — sticks on real contact, not a 2m wake
    hitGrow: 0.5,
    maxLifetime: 3, // THE fuse — 0.8s rate ⇒ ~3 bombs live per shooter
    stick: true,
  },
  [WeaponType.BeltSticky]: {
    // Belt twin of the glue bomb — same payload, hand-thrown lob. The
    // slow arc is the COMBO enabler: it hangs long enough for your own
    // shell to catch up and swallow it (stats.rides). Own weaponType so
    // the wire tells toss from launcher — the shared type used to make
    // belt throws free (server couldn't charge the nugget).
    directDamage: 45,
    aoeDamage: 35,
    aoeRadius: 11,
    knockbackForce: 40,
    forceMode: 'push',
    speed: 20,      // a third of the launcher's muzzle — hangs catchable
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.25,
    hitGrow: 0.5,
    maxLifetime: 3.5, // a beat longer than the launcher — the lob needs hang time to BE caught
    stick: true,
    rides: true,
  },
  [WeaponType.ClusterBomb]: {
    // Belt cluster: a fuse bomb whose pop is only the carrier — the real
    // damage is the bomblet scatter it releases (each claims with
    // ClusterBomblet stats, so the parent's radius stays honest).
    directDamage: 30,
    aoeDamage: 15,
    aoeRadius: 8,
    knockbackForce: 12, // the pop is only the delivery — the payload shoves
    forceMode: 'push',
    speed: 40,
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.25, // near-contact only — an 8m proxy popped the carrier on anything nearby
    hitGrow: 2,
    maxLifetime: 1.6, // fuse pop releases the bomblets
    cluster: { count: 5, radius: 9 }, // bomblet scatter footprint around the pop
  },
  [WeaponType.ClusterBomblet]: {
    // Child charge — small pop, small radius; count is the weapon.
    directDamage: 15,
    aoeDamage: 12,
    aoeRadius: 6,
    knockbackForce: 7, // popcorn pop, not a launcher — 5 stacked ≈ a rocket's worth
    forceMode: 'push',
    speed: 0, // spawned mid-air by the carrier, never muzzle-fired
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0,
    hitMax: 0.25, // bomblets must LAND — a fat proxy pops the rain mid-air
    hitGrow: 1,
    maxLifetime: 1.1,
  },
  [WeaponType.Javelin]: {
    // Thrown dart: near-flat long throw, heavy single-target pierce.
    // No splash — the skill shot IS the reward.
    directDamage: 60,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 26, // the stagger IS the hit feedback — a 60dmg spear shoves
    forceMode: 'push',
    speed: 120,  // bolt-launcher velocity — a thrown spear shouldn't lob
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0,
    hitMax: 0.25, // belt rule — a thrown spear skewers on the shaft, not a wake
    hitGrow: 0.2,
    maxLifetime: 12, // ~1.4km — spear prayers stay live; fuse only bounds desynced replicas
  },
  [WeaponType.ImpactGrenade]: {
    // Contact-fused blast nade: flies flat and far, pops on ANY touch,
    // medium-high damage in a tight envelope — a real kill tool whose
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
    // T2 concussion grenade: the blast is a STRIP, not a kill — small
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
    hitMax: 0.25, // belt rule — and it phases through bodies anyway
    hitGrow: 2,
    maxLifetime: 1.5,
    armTime: 1.5, // never arms — same never-pops-on-contact contract as Grenade
    terrainBounce: true,
    bounceRestitution: 0.5,
    bounceFriction: 0.7,
  },
  [WeaponType.RemoteRailgun]: {
    // Belt capacitor slug: 0.4s of readable lob, then a railgun-class beam
    // down its velocity line and a pop at whatever the beam touches. The
    // slug itself can also contact-pop before discharge like an impact nade.
    directDamage: 70,
    aoeDamage: 25,
    aoeRadius: 7,
    knockbackForce: 35,
    forceMode: 'push',
    speed: 40,    // slower lob — a readable cap-to-discharge window
    gravity: false, // flat flight: the ray tracks the throw line
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.25, // belt rule — the reach is the beam, not a wake
    hitGrow: 0.3,
    maxLifetime: 4, // intercept before discharge → plain impact pop
    rayDelay: 0.4,
    rayRange: 160,
  },
  [WeaponType.Sprinkler]: {

    // Sprinkler: plasma-gun cadence (~10/s ≈ 140dps on paper) but every bolt
    // arcs under world gravity inside a slight cone — mid-range area
    // denial, not a dueling laser. Lower direct damage + tiny pop so the
    // stream rewards saturation over precision.
    directDamage: 12,
    aoeDamage: 5,
    aoeRadius: 3,
    knockbackForce: 9,
    forceMode: 'push',
    speed: 120,    // slower than plasma's 160 — an arc needs airtime to read
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 1.2,
    hitGrow: 0.3,
    maxLifetime: 3, // arcs need hang time — ~1.9s to reach a 60m lob
  },
  [WeaponType.Slam]: {
    // Not a projectile — the Q-skill lands as a ground AOE. Ballistic
    // fields are inert; only aoe/knock stats are live.
    directDamage: 0,
    aoeDamage: 35,
    aoeRadius: 9,
    knockbackForce: 40,
    forceMode: 'push',
    speed: 0,
    gravity: false,
    bodyRadius: 0,
    hitMin: 0,
    hitMax: 0,
    hitGrow: 0,
  },
  [WeaponType.Repair]: {
    // Hitscan repair beam — the sting vs creatures exists so the tool
    // isn't a dead slot in a fight, but its real damage is the heal:
    // REPAIR_HEAL_PER_TICK flows into a friendly deployable, overflow
    // banking as armor up to REPAIR_ARMOR_MULT × its base hp.
    directDamage: 6,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 0,
    gravity: false,
    bodyRadius: 0,
    hitMin: 0,
    hitMax: 0,
    hitGrow: 0,
  },
  [WeaponType.ArmorGrenade]: {
    // Support ordnance: the blast is deliberately mid — the payoff is the
    // plating it sprays onto EVERYTHING it catches (players via the armor
    // pool, creatures as overcap health). Arming the enemy is the cost of
    // plating your own push — see ARMORNADE_* below.
    directDamage: 0,
    aoeDamage: 40,
    aoeRadius: 10,
    knockbackForce: 25, // a nudge, not a launcher — the plating is the payload
    forceMode: 'push',
    speed: 40,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0,
    hitMax: 0.25, // belt rule — plating lands on contact, not a fat wake
    hitGrow: 2,
    maxLifetime: 2,
  },
  [WeaponType.HealBeam]: {
    // Hitscan heal — the payload is HP on a friend, not damage. directDamage
    // stays 0 so a claim routed through the damage path lands nothing;
    // the heal itself is server-derived (HEALBEAM_* in weapons.ts).
    directDamage: 0,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 0,
    gravity: false,
    bodyRadius: 0,
    hitMin: 0,
    hitMax: 0,
    hitGrow: 0,
  },
  [WeaponType.HealGrenade]: {
    // Heal burst: tight radius, the sting vs enemies is the tax on a
    // misthrow — allies get the strong heal, foes get a shove + graze.
    directDamage: 0,
    aoeDamage: 12,
    aoeRadius: 6,
    knockbackForce: 22,
    forceMode: 'push',
    speed: 40,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0,
    hitMax: 0.25, // belt rule — the heal pops on real contact or the fuse
    hitGrow: 2,
    maxLifetime: 2,
  },
  [WeaponType.ProxyGrenade]: {
    // Proximity-fused zone pop: a 1s fuse whose trigger bubble inflates
    // 0→4m over its whole life — the closer it is to popping, the wider
    // the net. Toss it into a fight and it cooks off the moment anyone
    // wanders into the bubble (or the fuse lands anyway).
    directDamage: 35,
    aoeDamage: 30,
    aoeRadius: 6,
    knockbackForce: 22,
    forceMode: 'push',
    speed: 40,   // thrown lob — enough to clear a doorway, not a dart
    gravity: true,
    bodyRadius: 0.22,
    hitMin: 0,
    hitMax: 4,   // the proxy bubble ceiling — 4m radius at fuse end
    hitGrow: 1,  // grows for the whole 1s life — full width AT the pop
    maxLifetime: 1,
  },
  [WeaponType.SatchelCharge]: {
    // Satchel charge: hand-planted bomb, not a grenade. Near-zero throw
    // speed means you have to BE there — brush past a generator or an
    // enemy's back, slap it on, and it glues in place for a slow 4s fuse.
    // The payoff is the biggest belt blast in the kit.
    directDamage: 150,
    aoeDamage: 130,
    aoeRadius: 17,
    knockbackForce: 75,
    forceMode: 'push',
    speed: 10,    // an underhand lob — a few meters of range, no tossing over walls
    gravity: true,
    bodyRadius: 0.28,
    hitMin: 0,
    hitMax: 0,   // NO proxy wake — a planted charge only sticks on true contact
    hitGrow: 0.1,  // >0 so hitRadiusAt never divides by zero; hitMax 0 makes it moot
    maxLifetime: 4, // THE fuse — long enough to walk away, short enough the victim hears it
    stick: true,   // hand-planted: rests where it lands until the fuse
  },
  [WeaponType.MRVLauncher]: {

    // Mortar's counterpart: a bouncing carrier shell that AIRBURSTS at
    // ~1s into bomblets — one volley in one direction (MRV, not MIRV:
    // the bomblets scatter, they're not independently targeted). The
    // carrier's own pop is small; the bomblet rain is the weapon.
    directDamage: 30,
    aoeDamage: 15,
    aoeRadius: 8,
    knockbackForce: 15, // the pop is delivery — the rain does the shoving
    forceMode: 'push',
    speed: 60,          // mortar muzzle — same lob line, different payload
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.5,          // bombardment weapon — no fat wake proxy, the rain is the reach
    hitGrow: 0.5,
    maxLifetime: 1.5,     // fuse pop releases the bomblets mid-air — ~80m of carry before the split
    fuseOnly: true,       // bodies don't pop it — a 55 m/s contact shell that
                        // also rains bomblets is a strictly-better mortar
    terrainBounce: true,  // skips along until the fuse — the airburst needs the carry
    bounceRestitution: 0.35, // = client MRV_BOUNCE_RESTITUTION
    bounceFriction: 0.7,
    cluster: { count: 6, radius: 5 }, // bomblet scatter footprint at the burst point
  },
  [WeaponType.MRVBomblet]: {
    // Airburst child — contact pop on whatever it rains onto. Count is
    // the weapon: 6 × ~29 max ≈ a mortar's worth spread over an area.
    // 16m ring: six overlapping footprints make a real denial field —
    // at 6m the rain read as fireworks, not zoning.
    directDamage: 18,
    aoeDamage: 20,
    aoeRadius: 16,
    knockbackForce: 8,
    forceMode: 'push',
    speed: 0, // scattered by the carrier, never muzzle-fired
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0,
    hitMax: 0.5,          // bomblets must LAND — a big proxy would pop them mid-air on anything nearby
    hitGrow: 1,
    maxLifetime: 10,    // safety TTL only — contact pops them; an air fuse wastes the rain
  },
  [WeaponType.Bombard]: {
    // The cannon's bigger, meaner brother: an even fatter iron ball that
    // NEVER detonates — it shatters into shards on contact (terrain,
    // walls, shields, bodies; no arm window). The crumble carries a small
    // standard 2m splash sphere, so a near-miss at the contact point still
    // tags — a plain reliable sphere, NOT a shard cone. The player
    // envelope rides directDamage (splash is a fraction of the direct line
    // by convention).
    directDamage: 140,   // tops every primary — and the only headline
                         // number actually landable on a body: Mortar's
                         // 120 is fuse-gated (armTime 1.5s ≈ 82m), its
                         // real ceiling is the 100 inner splash ring.
                         // The planted satchel (150) still owns the
                         // overall record; also the shrapnel ceiling.
    aoeDamage: 140,      // wildlife splash mirrors the player envelope —
                         // a shard is a shard regardless of what it hits
    aoeRadius: 2,        // tiny, reliable tag: the contact point and
                         // nothing more. (A 9m shard cone read as
                         // unreliable — most of it never connected.)
    knockbackForce: 12,  // shard thump — staggers, doesn't launch
    forceMode: 'push',
    speed: 100,        // faster than the cannon's 80 — a flat siege slug, not a lob
    gravity: true,
    bodyRadius: 1.05,    // HUGE — visibly wider than the 0.8 cannonball
    hitMin: 0,
    hitMax: 1.5,         // modest proxy — a siege slug earns contact, not a 2m wake
    hitGrow: 0.5,
    maxLifetime: 6,    // ~570m of carry before the fuse crumbles it mid-air
    // Bounce SHELVED (it felt strictly worse): maxBounces 0 disables the
    // skip — the slug crumbles on first dirt contact, as before. The skip
    // fields stay so it can be re-tried by setting maxBounces 1.
    terrainBounce: true,
    bounceRestitution: 0.5,
    bounceFriction: 0.5,
    maxBounces: 0,
  },
};

/** FNV-1a — stable string→u32 seed shared by server spawn and client
 *  replicas, so a jittered fuse pops at the same age on both ends. */
export function idSeed(id: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  // oxlint-disable-next-line no-bitwise -- unsigned coercion, Math.trunc keeps the sign
  return h >>> 0 || 1;
}

/** Effective fuse for one projectile: `maxLifetime × (1 ± ttlJitter)`,
 *  the sign/spread seeded by `seed` (a projectile id hash, or any u32). */
export function jitteredTtl(stats: Pick<WeaponStats, 'maxLifetime' | 'ttlJitter'>, seed: number): number | undefined {
  if (!stats.maxLifetime) {return undefined;}
  const j = stats.ttlJitter ?? 0;
  if (!j) {return stats.maxLifetime;}
  // oxlint-disable-next-line no-bitwise -- unsigned coercion, Math.trunc keeps the sign
  return stats.maxLifetime * (1 - j + 2 * j * ((seed >>> 0 || 1) / 4_294_967_296));
}

// Repair-tool economy — one number set on both ends so the server heal
// and the client beam agree without trusting the claim.
