// Per-weapon stat table — the data half of weapons.ts (types/helpers
// stay there; this file is one record, nothing else). Do not hand-edit
// semantics lightly: shared sims, bots and HUDs all read these rows.

export enum WeaponType {
  Rocket = 0,
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
}

export interface WeaponStats {
  /** Damage on direct hit (server `shot` handler) */
  directDamage: number;
  /** Splash damage at blast center */
  aoeDamage: number;
  /** Splash radius (m) — 0 = no splash */
  aoeRadius: number;
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
  /** Cluster carrier — on detonation the SERVER scatters `count` bomblet
   *  blasts (ClusterBomblet stats) inside `radius` of the impact point.
   *  Client bomblets are visual-only: they never claim damage, so remote
   *  hits stay server-authoritative. */
  cluster?: { count: number; radius: number };
  /** Mid-flight hitscan discharge (remote railgun): at `rayDelay` seconds
   *  the projectile fires a beam along its velocity and dies at the hit
   *  point (or at rayRange on a miss). The server reach check adds
   *  rayRange to the legal flight distance once airtime passes rayDelay. */
  rayDelay?: number;
  rayRange?: number;
}

/** Explosion VFX dome = aoeRadius × this — damage always reaches a bit past
 *  the visual edge (covers the shock ring), and the two can never drift. */
export const WEAPONS: Record<number, WeaponStats> = {
  [WeaponType.Rocket]: {
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 8.0, // ~1.3× the VFX dome — damage reaches the ring's edge
    knockbackForce: 28.0,
    forceMode: 'push',
    speed: 120.0,
    gravity: true,
    bodyRadius: 0.18,
    hitMin: 0.0,
    hitMax: 8.0,
    hitGrow: 2.0,
  },
  [WeaponType.Disc]: {
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 10.0,
    knockbackForce: 25.0,
    forceMode: 'push', // launcher disc knocks back like everything else
    speed: 80.0,
    gravity: false,
    bodyRadius: 0.5,
    hitMin: 0.3,
    hitMax: 8.0,
    hitGrow: 2.0,
  },
  [WeaponType.DiscPull]: {
    // Belt disc (C): the implosion — pulls targets toward the blast.
    directDamage: 50,
    aoeDamage: 15,
    aoeRadius: 10.0, // slightly exceeds the 8m Implosion VFX — pull reaches everything it visibly sucks
    knockbackForce: 25.0,
    forceMode: 'pull',
    speed: 80.0,
    gravity: false,
    bodyRadius: 0.5,
    hitMin: 0.3,
    hitMax: 8.0,
    hitGrow: 2.0,
  },
  [WeaponType.Grenade]: {
    directDamage: 50,
    aoeDamage: 20,
    aoeRadius: 13.0,
    knockbackForce: 35.0,
    forceMode: 'push',
    speed: 40.0,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0.0,
    hitMax: 8.0,
    hitGrow: 2.0,
    maxLifetime: 2.0,
  },
  [WeaponType.Chaingun]: {
    directDamage: 8, // ~89 dps at 11/s — below plasma (125) but hitscan-easy; 13 slugs to kill a player
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 250.0,
    gravity: false,
    bodyRadius: 0.15,
    hitMin: 0.0,
    hitMax: 0.5, // tight proxy cap — slugs get a small wake, not the 8m shell drag
    hitGrow: 2.0,
  },
  [WeaponType.Mortar]: {
    directDamage: 80,
    aoeDamage: 40,
    aoeRadius: 18.0,
    knockbackForce: 45.0,
    forceMode: 'push',
    speed: 55.0,
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0.0,
    hitMax: 2.0, // tight proxy — the big splash is the forgiving part, not the wake
    hitGrow: 2.0,
    maxLifetime: 6.0,
  },
  [WeaponType.GrenadeLauncher]: {
    directDamage: 50,
    aoeDamage: 20,
    aoeRadius: 13.0,
    knockbackForce: 35.0,
    forceMode: 'push',
    speed: 55.0,
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0.0,
    hitMax: 2.0, // tight proxy — bouncing shells shouldn't drag a huge wake
    hitGrow: 2.0,
    maxLifetime: 2.5,
  },
  [WeaponType.Flak]: {
    directDamage: 9, // per shard — 9 shards ≈ 81 max
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 90.0,
    gravity: true,
    bodyRadius: 0.12,
    hitMin: 0.0,
    hitMax: 2.0,
    hitGrow: 0.5,
    maxLifetime: 4.0,
  },
  [WeaponType.PlasmaCannon]: {
    directDamage: 35,
    aoeDamage: 12,
    aoeRadius: 5.5,
    knockbackForce: 20.0,
    forceMode: 'push',
    speed: 90.0,
    gravity: false,
    bodyRadius: 0.2,
    hitMin: 0.0,
    hitMax: 2.0, // tight proxy — the fat bolt is already generous
    hitGrow: 2.0,
  },
  [WeaponType.PlasmaGun]: {
    // Quake 2/3 plasma: rapid volley of fat bolts — chain-like cadence
    // (~7.7/s, ~108dps) but a visible projectile you can dodge, so it
    // pays below chaingun's effective DPS vs movers and above vs track.
    directDamage: 14,
    aoeDamage: 4,
    aoeRadius: 2.5, // tiny pop — bolts sting, they don't splash
    knockbackForce: 8.0,
    forceMode: 'push',
    speed: 160.0,   // slower than chain slugs (250), fast enough to lead lightly
    gravity: false,
    bodyRadius: 0.32, // visibly chunky bolt — generous vs players
    hitMin: 0.0,
    hitMax: 1.2,
    hitGrow: 0.3,
    maxLifetime: 1.5, // ~240m of reach
  },
  [WeaponType.Railgun]: {
    // Quake railgun: 80dmg slug at 450 m/s ≈ hitscan past ~200m. Small AOE
    // so near-misses still pop and the weapon isn't useless vs movement.
    directDamage: 80,
    aoeDamage: 30,
    aoeRadius: 6.0,
    knockbackForce: 35.0,
    forceMode: 'push',
    speed: 450.0,
    gravity: false,
    bodyRadius: 0.18,
    hitMin: 0.0,
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
    knockbackForce: 40.0,
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
    knockbackForce: 4, // the pin: a nudge per tick — it accrues at 22/s, keep it modest
    forceMode: 'push',
    speed: 0,
    gravity: false,
    bodyRadius: 0,
    hitMin: 0,
    hitMax: 0,
    hitGrow: 0,
  },
  [WeaponType.Shotgun]: {
    // Pump pellets: 10 × 7dmg ≈ 70 point-blank, ~3× tighter cone than flak.
    // Fast slugs (300 m/s) on a 0.4s fuse ≈ 120m of reach — usable at mid
    // range where flak's lobbed shards scatter into nothing.
    directDamage: 7, // per pellet — 10 pellets ≈ 70 max
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 300.0,
    gravity: false,
    bodyRadius: 0.1,
    hitMin: 0.0,
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
    aoeRadius: 10.0,
    knockbackForce: 40.0,
    forceMode: 'push',
    speed: 72.0,    // faster than GL's 55 — it skips far between bounces
    gravity: true,
    bodyRadius: 0.8, // HUGE — the comedy is the ball, not the damage
    hitMin: 0.0,
    hitMax: 2.0,    // proxy scaled to match the bigger ball
    hitGrow: 1.5,
    maxLifetime: 6.0, // skitters around until fuse or contact ends it
  },
  [WeaponType.RocketLauncher]: {
    // RPG-style missile: flat trajectory, deliberately SLOW (readable in
    // flight, dodgeable at range) in exchange for the biggest non-mortar
    // blast. The Tribes/Quake rocket niche the Bolt Launcher never filled.
    directDamage: 90,
    aoeDamage: 35,
    aoeRadius: 14.0, // big — but under mortar's 18
    knockbackForce: 55.0, // rocket-jump tier — the tool IS the movement
    forceMode: 'push',
    speed: 48.0,
    gravity: false,
    bodyRadius: 0.35,
    hitMin: 0.0,
    hitMax: 2.5, // a fat warhead drags a real wake
    hitGrow: 0.4,
    maxLifetime: 6.0, // ~290m of flat reach
  },
  [WeaponType.Pistol]: {
    // Hold-out sidearm: fast flat slug, modest damage — the panic button
    // when the primary is dry or wrong for the range.
    directDamage: 14,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 4.0,
    forceMode: 'push',
    speed: 220.0,
    gravity: false,
    bodyRadius: 0.12,
    hitMin: 0.0,
    hitMax: 0.5,
    hitGrow: 0.1,
    maxLifetime: 0.6,
  },
  [WeaponType.Revolver]: {
    // Hand cannon: three hits kill — slow cadence, heavy single slug.
    directDamage: 34,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 8.0,
    forceMode: 'push',
    speed: 260.0,
    gravity: false,
    bodyRadius: 0.14,
    hitMin: 0.0,
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
    aoeRadius: 11.0,
    knockbackForce: 40.0,
    forceMode: 'push',
    speed: 55.0,
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0.0,
    hitMax: 2.0, // sticks sit still — the blast is the reach, not the wake
    hitGrow: 0.5,
    maxLifetime: 3.0, // THE fuse — 0.8s rate ⇒ ~3 bombs live per shooter
  },
  [WeaponType.ClusterBomb]: {
    // Belt cluster: a fuse bomb whose pop is only the carrier — the real
    // damage is the bomblet scatter it releases (each claims with
    // ClusterBomblet stats, so the parent's radius stays honest).
    directDamage: 30,
    aoeDamage: 15,
    aoeRadius: 8.0,
    knockbackForce: 12.0, // the pop is only the delivery — the payload shoves
    forceMode: 'push',
    speed: 42.0,
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0.0,
    hitMax: 8.0,
    hitGrow: 2.0,
    maxLifetime: 1.6, // fuse pop releases the bomblets
    cluster: { count: 5, radius: 6.0 }, // bomblet scatter footprint around the pop
  },
  [WeaponType.ClusterBomblet]: {
    // Child charge — small pop, small radius; count is the weapon.
    directDamage: 15,
    aoeDamage: 12,
    aoeRadius: 6.0,
    knockbackForce: 7.0, // popcorn pop, not a launcher — 5 stacked ≈ a rocket's worth
    forceMode: 'push',
    speed: 0, // spawned mid-air by the carrier, never muzzle-fired
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0.0,
    hitMax: 4.0,
    hitGrow: 1.0,
    maxLifetime: 1.1,
  },
  [WeaponType.Javelin]: {
    // Thrown dart: near-flat long throw, heavy single-target pierce.
    // No splash — the skill shot IS the reward.
    directDamage: 60,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 14.0,
    forceMode: 'push',
    speed: 120.0,  // bolt-launcher velocity — a thrown spear shouldn't lob
    gravity: true,
    bodyRadius: 0.15,
    hitMin: 0.0,
    hitMax: 0.6,
    hitGrow: 0.2,
    maxLifetime: 2.4, // ~285m of reach — same as before, just faster
  },
  [WeaponType.ImpactGrenade]: {
    // Contact-fused knockback tool: flies flat and far, pops on ANY touch,
    // throws targets (and the thrower) hard without hurting much — the
    // dismount/boost grenade.
    directDamage: 25,
    aoeDamage: 10,
    aoeRadius: 7.0,
    knockbackForce: 45.0, // biggest shove in the belt
    forceMode: 'push',
    speed: 55.0,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0.0,
    hitMax: 6.0,
    hitGrow: 1.5,
    maxLifetime: 4.0, // contact usually pops it first
  },
  [WeaponType.RemoteRailgun]: {
    // Belt capacitor slug: 0.4s of readable lob, then a railgun-class beam
    // down its velocity line and a pop at whatever the beam touches. The
    // slug itself can also contact-pop before discharge like an impact nade.
    directDamage: 70,
    aoeDamage: 25,
    aoeRadius: 7.0,
    knockbackForce: 35.0,
    forceMode: 'push',
    speed: 40.0,    // slower lob — a readable cap-to-discharge window
    gravity: false, // flat flight: the ray tracks the throw line
    bodyRadius: 0.3,
    hitMin: 0.0,
    hitMax: 0.6, // the slug is a small throw — its reach is the beam, not a wake
    hitGrow: 0.3,
    maxLifetime: 4.0, // intercept before discharge → plain impact pop
    rayDelay: 0.4,
    rayRange: 160.0,
  },
  [WeaponType.Sprinkler]: {
    // Sprinkler: plasma-gun cadence (~9/s ≈ 108dps on paper) but every bolt
    // arcs under world gravity inside a slight cone — mid-range area
    // denial, not a dueling laser. Lower direct damage + tiny pop so the
    // stream rewards saturation over precision.
    directDamage: 12,
    aoeDamage: 5,
    aoeRadius: 3.0,
    knockbackForce: 9.0,
    forceMode: 'push',
    speed: 120.0,    // slower than plasma's 160 — an arc needs airtime to read
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0.0,
    hitMax: 1.2,
    hitGrow: 0.3,
    maxLifetime: 3.0, // arcs need hang time — ~1.9s to reach a 60m lob
  },
  [WeaponType.Slam]: {
    // Not a projectile — the Q-skill lands as a ground AOE. Ballistic
    // fields are inert; only aoe/knock stats are live.
    directDamage: 0,
    aoeDamage: 35,
    aoeRadius: 9.0,
    knockbackForce: 40.0,
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
    aoeRadius: 10.0,
    knockbackForce: 25.0, // a nudge, not a launcher — the plating is the payload
    forceMode: 'push',
    speed: 40.0,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0.0,
    hitMax: 8.0,
    hitGrow: 2.0,
    maxLifetime: 2.0,
  },
};

// Repair-tool economy — one number set on both ends so the server heal
// and the client beam agree without trusting the claim.
