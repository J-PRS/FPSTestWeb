// Per-weapon stat table - the data half of weapons.ts (types/helpers
// stay there; this file is one record, nothing else). Do not hand-edit
// semantics lightly: shared sims, bots and HUDs all read these rows.

export enum WeaponType {
  BoltLauncher = 0, // the prototype bolt launcher - was 'Rocket'; id kept for wire compat
  Disc = 1,
  Grenade = 2, // thrown fuse bomb (F key) - distinct from the launcher
  Chaingun = 3,
  Mortar = 4,
  GrenadeLauncher = 5,
  Flak = 6,
  PlasmaCannon = 7, // the fat slow T1/T2 bolt - was 'Plasma'; id kept for wire compat
  Slam = 8, // skill ground-slam - not a projectile, but lands as an AOE
  Railgun = 9,
  Melee = 10, // E-key punch - not a projectile; aoe fields drive server validation
  Implodisc = 11, // belt disc (C) - the implosion disc, pulls targets toward the blast
  Lightning = 12, // Quake LG: hitscan beam, ticks ~22/s; aoe fields validate the pin-blast
  Shotgun = 13, // pellet burst - tighter cone than flak, works to mid range
  Cannon = 14, // Serious Sam cannonball - fast, fat, skips off terrain, pops on contact
  MissileLauncher = 15, // classic RPG: slow straight-flying missile, big boom, rocket-jump friendly (was 'RocketLauncher' - renamed when the universal flat rocket took the name)
  Pistol = 16,        // hold-out sidearm (G): quick semi-auto slug, no splash
  Revolver = 17,      // hold-out sidearm (T): slow hand-cannon slug, no splash
  Sticky = 18,        // sticky launcher: lobbed bomb that glues to surface/player, 3s fuse, chain-detonates
  ClusterBomb = 19,   // belt throw: fuse pop scatters bomblets that each detonate
  Javelin = 20,       // belt throw: fast flat dart - direct damage only, no splash
  ImpactGrenade = 21, // belt throw: flat arc, contact pop, low damage, big shove
  ClusterBomblet = 22,// spawned by ClusterBomb detonation - never fired directly
  PlasmaGun = 23,     // Quake-style rapid plasma: fast cadence, mid-speed fat bolt
  RemoteRailgun = 24, // belt throw: slug discharges a hitscan rail mid-flight, pops at the hit point
  Sprinkler = 25,     // plasma hose: rapid stream of arced bolts with cone spread
  Repair = 26,        // repair-tool sidearm: short beam that heals deployables, overheal → armor
  ArmorGrenade = 27,  // belt throw: mid blast that plates every player + creature it catches
  MRVLauncher = 28,   // mortar's counterpart: bouncing carrier shell airbursts into bomblets (MRV - one volley, not MIRV)
  MRVBomblet = 29,    // spawned by MRVLauncher detonation - contact pop, never fired
  HealBeam = 30,      // support beam: hitscan that HEALS the friendly target it pins - jet energy is the ammo
  HealGrenade = 31,   // belt throw: small blast, strong heal for allies caught; enemies eat the sting + shove
  ProxyGrenade = 32,  // belt throw: 1s fuse, proxy bubble inflating to 4m - toss-and-zone pop
  SatchelCharge = 33,    // belt throw: infiltrator satchel - glues to surface/player, 4s fuse, objective-killer blast
  Concussion = 34,       // belt throw: T2 conc - fuse bomb, tiny sting, huge shove, strips the flag and drains jets
  Bombard = 35,          // heavy siege slug: the cannon's bigger brother - biggest direct hit in the game, NEVER explodes, crumbles on any contact
  BeltSticky = 36,       // belt throw: hand-lobbed glue bomb - same payload as the launcher, but slow enough to be CAUGHT: a same-owner shell picks it up mid-flight and it rides dead-center to the target (Painkiller combo)
  Hook = 37,             // belt throw: rope dart - terrain/world contact reels the OWNER toward the anchor; a body hit reels the VICTIM toward the shooter. One impulse, no damage, no blast.
  Shocklance = 38,       // melee-key pull-out zap: one-shot hitscan bolt, lance reach. No backstab/energy economy yet.
  EMP = 39,              // belt throw: EMP grenade - fuse bomb, 0 damage, drains all jet energy + strips shield in blast radius. Timer detonation (not proxy/hit) to avoid being OP.
  BeltDisc = 40,        // belt throw: the plain push belt disc - Implodisc carries the pull identity
  Blaster = 41,         // T1 energy sidearm - jet energy is the magazine (energyCost per shot)
  Gonne = 42,        // light-frame cannon: the same 80 m/s arc shell in a handgonne - the gravity-arc primary family member for lights
  Basilisk = 43,        // heavy-frame cannon: the same 80 m/s arc shell in a huge-bore long gun - the gravity-arc primary family member for heavies
  RocketLauncher = 44,  // universal rocket: the Bolt Launcher's shell with no gravity - every class fields it
  Howitzer = 45,        // siege artillery: mortar-on-steroids - 5-charge drum, 6s/round regen, arming fuse that bars close work, and a violent recoil kick that punishes grounded firing
  FastDiscLauncher = 46, // the flat fast spinfusor: 130 m/s straight disc, small splash - the fast-straight-proj pick in place of the benched universal rocket
}

export interface WeaponStats {
  /** Damage on direct hit (server `shot` handler) */
  directDamage: number;
  /** Splash damage at blast center */
  aoeDamage: number;
  /** Splash radius (m) - 0 = no splash */
  aoeRadius: number;
  /** Per-weapon splash band fractions of the direct hit (inner/mid/outer
   *  thirds of aoeRadius). Absent = global AOE_BAND_SCALES (0.75/0.5/0.25). */
  aoeScales?: readonly [number, number, number];
  /** Impulse magnitude at blast center (m/s) */
  knockbackForce: number;
  /** 'pull' = implosion toward center (disc) */
  forceMode: 'push' | 'pull';
  /** Muzzle speed (m/s) - before player-velocity inheritance */
  speed: number;
  /** Shooter impulse opposite the aim direction, m/s (howitzer's
   *  violent launcher-kick). 0/absent = no recoil momentum. Applied on
   *  every fire path - client prediction, server authority, bot arsenal.
   */
  recoilImpulse?: number;
  /** Must be grounded (and not skiing) to fire — deploy weapons like the
   *  howitzer; the recoil-propulsion exploit dies by rule, not tuning. */
  groundedOnly?: boolean;
  /** Fraction of shooter velocity the shell inherits (default 0.5).
   *  0 = the flight line is pure aim - for weapons whose path IS the
   *  payload (a mid-flight ray discharges down the velocity line). */
  inherit?: number;
  /** Whether world gravity (-28 m/s²) bends the trajectory - boolean by
   *  design: physics is physics, per-weapon fudge factors read as fake. */
  gravity: boolean;
  /** Core hitbox radius (m) - a hit inside this counts as direct */
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
  /** Cone slope factor for a `burst` fan - the golden-angle offsets each
   *  pellet's dir by up to this much (0.10 ≈ flak's wide shard cone,
   *  0.035 ≈ the pump's tight spray). Only read when burst > 1. */
  pelletSpread?: number;
  /** Per-shot TTL spread: each projectile's fuse scales by ±this fraction,
   *  seeded from its projectileId so server and client replicas pop at the
   *  same age. A burst of shards should raggedly fade, not pop in unison. */
  ttlJitter?: number;
  /** Cluster carrier - on detonation the SERVER scatters `count` bomblet
   *  blasts (ClusterBomblet stats) inside `radius` of the impact point.
   *  Client bomblets are visual-only: they never claim damage, so remote
   *  hits stay server-authoritative. */
  cluster?: { count: number; radius: number };
  /** Body contact doesn't detonate - the shell flies through players and
   *  creatures (MRV carrier: a contact pop would make it a fast mortar;
   *  the fuse airburst IS the attack). Terrain, walls, and shield domes
   *  still stop it. Both ends read this so the sim stays authoritative. */
  fuseOnly?: boolean;
  /** T2 mortar arming delay: player/creature contact before this age does
   *  NOT detonate - the shell phases through bodies until the fuse arms.
   *  Terrain/wall/shield contact still applies (client bounces, server
   *  pops) - the arm time gates the KILL, not the landing. */
  armTime?: number;
  /** Bodies phase through until this age (defaults to armTime). Set to 0
   *  when a shell bounces off dirt yet pops on body contact at ANY age -
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
   *  off the heightfield normal and keeps it live until the fuse pops -
   *  clients replay the same bounce in their replica sim. */
  terrainBounce?: boolean;
  /** Shared bounce constants - server sim and client config read the
   *  same numbers so the replica arc matches the authoritative one. */
  bounceRestitution?: number; // normal velocity kept per bounce
  bounceFriction?: number;    // tangential velocity kept per bounce
  maxBounces?: number;        // die on the Nth terrain hit (flak shards); unset = bounce until fuse
  firstBounceVelScale?: number; // |v| *= this on the FIRST terrain bounce only (cannonball's dead first skip)
  lodgeBounce?: number; // first terrain contact LODGES the shell in place (stuck path) and pops it this many seconds later - overrides the bounce arc
  /** Streamlining fields - optional metadata that auto-generates derived sets:
   *  - beltThrow: true → auto-added to BELT_THROW_WEAPONS
   *  - fireInterval: number → auto-populated in WEAPON_FIRE_INTERVAL_S
   *  - serverSimmed: defaults to true (all weapons are server-simmed)
   */
  beltThrow?: boolean;
  fireInterval?: number;
  /** Derived-set markers (weapons.ts + botClasses.ts scan these):
   *  - tier: class lock - 'light'/'medium' = EXACT class, 'heavy' = floor
   *  - gib: direct kill bursts the body (GIB_WEAPONS)
   *  - airtimeScale: direct damage x min(CAP, 1+airtime)
   *  - aoeBonus: directHitAoeBonus x1.5 club */
  tier?: 'light' | 'medium' | 'heavy';
  gib?: boolean;
  airtimeScale?: boolean;
  aoeBonus?: boolean;
  /** Presentation family: this weapon inherits another type's sfx tables
   *  (sfxKey) / viewmodel geometry+recoil (vmKey) - an alias to the type
   *  id, never a copied row in the presentation maps. */
  sfxKey?: WeaponType;
  vmKey?: WeaponType;
  /** Bot aim axis this weapon exercises (botSkill.weaponAxis reads it).
   *  Unset = thrown/no-skill type - shoots at 1x. */
  aimAxis?: 'snap' | 'track' | 'arcLead' | 'arcJudge';
  /** Hitscan beam weapon (Lightning/Repair/Shocklance/HealBeam) - the
   *  trigger fires a beam, not a spawn claim. SLOT_DEFS kind reads it. */
  beam?: boolean;
  /** First terrain bounce clamps the remaining fuse to this many seconds
   *  - a skip becomes a short cook-off instead of free ricochet time. */
  fuseAfterBounce?: number;
  /** T2 glue bomb: contact STOPS the shell instead of detonating - it
   *  freezes on terrain/walls, glues onto a player it touches (riding
   *  them until the fuse pops), and only `maxLifetime` triggers the
   *  blast. A detonation cooks siblings in radius - the stack is the
   *  weapon. Both ends read this so a stuck bomb looks and kills
   *  identically. */
  stick?: boolean;
  /** Rideable payload (belt sticky): while airborne, a same-owner
   *  projectile passing inside RIDE_CATCH_R swallows it - it stops
   *  simming, centers on the host, and detonates where the host dies.
   *  Both ends run the same catch or replicas unride. */
  rides?: boolean;
  /** Rope dart (Hook): contact is not an explosion - a body hit yanks the
   *  VICTIM toward the shooter, anything else yanks the OWNER toward the
   *  contact. knockbackForce is the impulse magnitude; aoe fields inert. */
  hook?: boolean;
  /** Jet energy per trigger pull (T1 blaster): the server gates + drains
   *  the moveSim tank on the fire intent; the client predicts the same
   *  check so a dry tank can't draw a ghost bolt. */
  energyCost?: number;
  /** Per-weapon pool rounds (plasma-gun pilot): clip size; absent =
   *  unlimited. Regen is lazy — reads accrue on the shooter's own clock. */
  ammoCap?: number;
  /** Pool regen cadence as a multiple of fireInterval — 2 = one round
   *  per 2× the shot interval, so a dry gun sustains at half rate. */
  ammoRegenMult?: number;
  /** Regen runs continuously even while firing (howitzer: the 6s charge
   *  IS the reload — freezing it per-shot would double the drum time).
   *  Default off: quick pools pause one interval post-shot so the clip
   *  reads down-only during a burst. */
  ammoAlwaysRegen?: boolean;
  /** Base cone radius always applied (sprinkler's fixed 0.05 hose) -
   *  sits UNDER any bloom growth, drawn from the same server-side seed. */
  spreadBase?: number;
  /** Bloom cone (chaingun): per-shot growth = +rate then ×exp, radius in
   *  dir-offset units capped at bloomMax. Decay starts one fireInterval
   *  after the last shot (lazy, applied on the next use). */
  bloomRate?: number;
  bloomExp?: number;
  bloomDecay?: number;
  bloomMax?: number;
  /** Sidearm (hold-out pull weapon): auto-derives the sidearm pool -
   *  same marker pattern as beltThrow, so a new sidearm registers here
   *  once instead of in a menu, a union type, and two tables. */
  sidearm?: boolean;
}

/** Catch radius for the belt-sticky combo - shared so the server and
 *  the client replica attach on the same tick. Tight on purpose: this
 *  is an aimed skill shot, not a vacuum. */
export const RIDE_CATCH_R = 1;


/** FNV-1a - stable string→u32 seed shared by server spawn and client
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

// Repair-tool economy - one number set on both ends so the server heal
// and the client beam agree without trusting the claim.
