// World gravity is authored in shared/movement.ts - the server sims the
// same fall the client predicts; derive, never copy.
import {GRAVITY, ENERGY} from '../../../shared/movement.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';
export { GRAVITY };

// Physics constants for debris and death physics
export const BOUNCE_Y = 0.35; // Vertical bounce coefficient
export const FRICTION_XZ = 0.8; // Horizontal friction coefficient
export const SHRINK_DUR = 0.5; // Debris shrink duration
export const GREY_DUR = 1; // Debris grey fade duration
export const BASE_SPEED = 9; // Base debris speed
export const EXTRA_SPEED = 14; // Extra random debris speed
export const LIFE_BASE = 6; // Base debris lifetime
export const LIFE_RAND = 2; // Random debris lifetime variation

// Player capsule geometry lives in shared/constants.ts - the server needs
// the same numbers to validate hit claims against networked positions.
export {
  PLAYER_RADIUS,
  CAPSULE_CYLINDER_HEIGHT, CAPSULE_CENTER_Y,
  EYE_OFFSET,
} from '../../../shared/constants.js';

// Player jetpack constants
// The jet economy is authored in shared/movement.ts (ENERGY) - the server
// shadow sims the same tank. These stay derived, never copies: a tune
// must move both ends at once.
export const MAX_ENERGY: number = ENERGY.max;
export const JET_DRAIN: number = ENERGY.jetDrain;
export const JET_CHARGE: number = ENERGY.jetCharge;

// Weapon constants
export const BOLT_FIRE_RATE = 1; // bolt launcher fire rate (seconds)
export const DISC_RATE = 1; // Disc fire rate (seconds)
export const CHAINGUN_RATE = 0.09; // Chaingun fire rate (seconds)
export const LG_RATE = 0.05;       // Lightning gun tick - clean 20/s for the stepped ramp
// Death-burst economy, beam reach, and the chain fork live in
// shared/combat.ts - the server banks and traces the same numbers the
// client predicts.
export { LG_POP_DMG_CAP, LG_POP_CHARGE_MULT, LG_CHARGE_DRAIN_S as LG_CHARGE_DECAY_S, LG_POP_RADIUS_MAX, LG_POP_RADIUS_MIN, LG_RANGE, LG_CHAIN_RANGE, LG_CHAIN_DMG_SCALE, LG_BOUNCE_RANGE, LG_BOUNCE_DMG_SCALE, lgBounceDmgScale } from '../../../shared/combat.js';

// Projectile gameplay stats (speed, gravity, hitboxes, damage, fuse) live in
// shared/weapons.ts - the single source of truth the server validates with.
// The constants that remain here are visual/VFX scales only.
export const EXPLOSION_VFX_RADIUS = 6; // explosion VFX scale unit - blastRadius/this = visual size
export const SCORCH_MAX = 48;          // terrain char decals - oldest evicted first
export const SPLAT_MAX = 24;           // ichor stain decals - matches terrain slot count



// Mortar - T1/T2 heavy siege shell: slow lob, the biggest splash in the game
export const MORTAR_RATE = 2; // Mortar fire rate - T2 is 0.5 rounds/sec

// Grenade launcher - T2 style: bouncing timed shells, explode on player contact
export const GL_RATE = 0.7; // Grenade launcher fire rate (seconds)
// GL/FLAK/MRV/CANNON bounce constants live in shared/weaponTable.ts -
// server sim and client config read the same numbers.

// Flak cannon - UT style: a spray of bouncing shards, direct-hit only
export const FLAK_RATE = 1.2; // Flak fire rate (seconds)
export const FLAK_SHARDS = 9; // Shards per shell
export const FLAK_SPREAD = 0.1; // Cone half-angle (radians-ish slope factor)
export const SG_PELLETS = 10;   // pellets per pump
export const SG_SPREAD = 0.035; // ~3× tighter than flak - mid-range viable
// Flak maxBounces lives in shared/weaponTable.ts (WEAPONS[6].maxBounces).

// Plasma cannon - T1/T2 fat energy bolt, sustained midrange fire
export const PLASMA_RATE = 0.28; // ~3.5 rps
// Plasma gun - Quake-style rapid bolts, cadence just under chaingun
export const PLASMAGUN_RATE = 0.13; // ~7.7 rps
export const SPRINKLER_RATE = 0.11; // ~9/s stream - saturation over precision
export const SPRINKLER_SPREAD = 0.05; // per-shot cone jitter (dir-offset units, flak-scale)
export const RAILGUN_RATE = 1.5; // Quake railgun cadence
export const SHOTGUN_RATE = 0.7; // pump cadence - punchy per shot, not spam
export const CANNON_RATE = 1.1; // must match WEAPON_FIRE_INTERVAL_S[Cannon] - server cadence law
export const BOMBARD_RATE = 1.6; // siege slug - one 160dmg ball per pull, deliberate cadence
export const RKT_RATE = 2.5; // RPG cadence - slower than mortar, one missile IS the event
// Hold-out sidearms (G/T/B) - pulled while the key is held, holstered on release
export const PISTOL_RATE = 0.22;  // snappy semi-auto - ~4.5 rps while held
export const REVOLVER_RATE = 0.6; // hand-cannon cadence - deliberate thumps
export const BLASTER_RATE = 0.3;  // must match weaponRows[Blaster].fireInterval - server cadence law
export const STICKY_RATE = 0.8; // sticky launcher - 0.8s vs 3s fuse ⇒ up to 3 live bombs per shooter
export const REPAIR_RATE = 0.1; // repair-tool beam tick - matches REPAIR_HEAL_PER_TICK's ~50 hp/s
export const MRV_RATE = 2.4; // MRV launcher - slower than mortar, one trigger = a volley
export const MELEE_COOLDOWN = 0.9;
export const MELEE_RANGE = 3.2;    // fist reach, meters
export { MELEE_ARC_DOT } from '../../../shared/weapons.js';
export { MELEE_CREATURE_DAMAGE as MELEE_DAMAGE } from '../../../shared/weapons.js';

// Game constants
// Spawn cadence is the OG RadialSpawner policy in entities.ts: random
// 0-10s trickle under BALL_MAX + instant refill when the field is empty.

// Ball constants
// The flight/enrage/teleport envelope is authored in shared/ballSim.ts -
// the server runs the same sim the client's solo/host path runs; derive,
// never copy. Spawn-policy and VFX knobs stay local.
export {
  BALL_MAX_DIST, BALL_TELE_MIN, BALL_TELE_MAX, BALL_TELE_MARGIN,
  BALL_ENRAGE_FORCE, BALL_ENRAGE_TIMEOUT, BALL_ENRAGE_DASH_DIST,
  BALL_ENRAGE_DASH_SPEED, BALL_BASE_RADIUS,
  BALL_SLIDE_VN_MIN, BALL_SLIDE_ENABLED, setBallSlide,
  BALL_ENRAGE_ENABLED, setBallEnrage,
} from '../../../shared/ballSim.js';
export const BALL_MAX = 32; // Maximum number of balls in play (OG maxSpawnCount parity)

// Ball enrage mode: instead of teleporting when out of range, far balls get
// angry and are pulled toward the player while still bouncing normally.
// ?mode=classic flips it off at boot for the pure bounce-and-shoot ruleset
// (balls teleport when lost, like the Unity original) - the flag lives in
// shared/ballSim.ts so the server sim and the local path read one switch.
// Balls stay enraged until they get a lunge off (or time out) - no distance
// cooldown, otherwise they'd always calm before reaching dash range
export const BALL_ENRAGE_TELEGRAPH_H = 8; // Glow ramps to white under this height in dash range

export const EMERGE_DUR = 0.8; // Ground spawns burrow up out of the dirt over this many seconds

// Crawlers - terrain-hugging targets that hop, chase, and pounce
export const CRAWLER_SPAWN_INTERVAL = 4; // Seconds between spawn attempts
export const CRAWLER_SPAWN_MIN = 40; // Spawn ring: min distance from player
export const CRAWLER_SPAWN_MAX = 90;
export const CRAWLER_RADIUS = 0.9;
export const CRAWLER_HEALTH = 70; // damage points - a rocket (50+15 splash) one-shots, chaingun needs ~14 slugs
export const CRAWLER_AGGRO_DIST = 70; // Chases inside this range
export const CRAWLER_POUNCE_DIST = 25; // Ground inside this range → windup → pounce
export const CRAWLER_WINDUP = 0.35; // Crouch telegraph before pounce (s)
export const CRAWLER_HOP_SPEED = 10; // Chase hop horizontal speed
export const CRAWLER_HOP_UP = 5; // Hop vertical kick
export const CRAWLER_POUNCE_SPEED = 30; // Pounce horizontal speed
export const CRAWLER_POUNCE_DAMAGE = 25; // Server-authoritative self-damage on pounce hit
export const CRAWLER_STUN = 0.5; // Blast knockback suppresses hopping this long

// Scarabs - cannon fodder. Spawn in packs, skitter fast, weak nibble.
// Everything about them is small except the count - they exist to be
// mowed down in satisfying clumps.
export const SCARAB_SPAWN_INTERVAL = 5;
export const SCARAB_SPAWN_MIN = 45;
export const SCARAB_SPAWN_MAX = 85;
export const SCARAB_PACK_MIN = 4;         // spawn cluster size
export const SCARAB_PACK_MAX = 7;
export const SCARAB_RADIUS = 0.55;
export const SCARAB_HEALTH = 20;          // one chaingun burst, a rocket takes the whole pack
export const SCARAB_SPEED = 12;         // fast ground skitter - they close distance NOW
export const SCARAB_ZIGZAG = 5;         // lateral weave amplitude (m/s) - hard to track
export const SCARAB_AGGRO_DIST = 90;    // pack descends from far
// Player-favor reach: every creature contact trigger uses the visual
// distance × this. Enemy melee landing at exactly its apparent reach reads
// as unfair; landing at 85% of it produces "oh I dodged that" moments -
// the player escapes hits that LOOKED like they should connect. Only the
// trigger shrinks - visuals, windups and the reach audit stay honest.
export const MELEE_FAVOR = 0.85;

export const SCARAB_BITE_DIST = 1.4;      // contact nibble reach
export const SCARAB_BITE_DAMAGE = 4;      // chip damage - dangerous ONLY in a swarm
export const SCARAB_BITE_FORCE = 3;
export const SCARAB_BITE_CD = 0.7;
export const SCARAB_STUN = 0.3;

// Grubs - the most mundane thing alive: slow fat maggots that inch
// toward you and pop. Walking piñatas - the nuggets are the point.
export const GRUB_SPAWN_INTERVAL = 7;
export const GRUB_SPAWN_MIN = 40;
export const GRUB_SPAWN_MAX = 80;
export const GRUB_RADIUS = 0.7;
export const GRUB_HEALTH = 30;
export const GRUB_SPEED = 2.4;            // genuinely slow - a slug pace
export const GRUB_AGGRO_DIST = 60;
export const GRUB_BITE_DIST = 1.5;
export const GRUB_BITE_DAMAGE = 6;
export const GRUB_BITE_FORCE = 5;
export const GRUB_BITE_CD = 1.2;
export const GRUB_STUN = 0.4;

// Snakes - sand vipers. Serpentine weave toward you, a readable coil
// wind-up, then a committed straight-line lunge. Mid-tier predator:
// faster and meaner than fodder, frailer than a crawler.
export const SNAKE_SPAWN_INTERVAL = 9;
export const SNAKE_SPAWN_MIN = 30;
export const SNAKE_SPAWN_MAX = 60;
export const SNAKE_RADIUS = 0.85;
export const SNAKE_HEALTH = 45;
export const SNAKE_SPEED = 6.5;           // weaves in FAST
export const SNAKE_AGGRO_DIST = 70;
export const SNAKE_STRIKE_DIST = 5.5;     // coil trigger (3D)
export const SNAKE_STRIKE_CD = 2.2;
export const SNAKE_WINDUP = 0.45;         // telegraph - dodge window
export const SNAKE_LUNGE_SPEED = 14;
export const SNAKE_LEAP_GRAV = GRAVITY; // leap arc pays world gravity - derives, never copies
export const SNAKE_LEAP_OVERSHOOT = 3.5;  // aim past the target - flies THROUGH
export const SNAKE_BITE_DIST = 2.4;       // lunge contact (3D)
export const SNAKE_BITE_DAMAGE = 14;
export const SNAKE_BITE_FORCE = 9;

// Gnats - a boid cloud of insectoid harassers. They ORBIT you in a
// jittery swarm; individuals dart in for a nip and zip back out. Never
// a committed divebomb - harassment, not a bombing run.
export const GNAT_SPAWN_INTERVAL = 6.5;
export const GNAT_SPAWN_MIN = 50;
export const GNAT_SPAWN_MAX = 80;
export const GNAT_CLOUD_MIN = 5;          // swarm size per spawn
export const GNAT_CLOUD_MAX = 9;
export const GNAT_RADIUS = 0.3;
export const GNAT_HEALTH = 8;             // a single chaingun slug pops one
export const GNAT_SPEED = 13;           // cruise speed around the cloud
export const GNAT_DART_SPEED = 24;      // nip dart - quick in-and-out
export const GNAT_ORBIT_R = 5;          // cloud radius around its center
export const GNAT_ORBIT_ALT = 4;        // cloud hovers above the player
export const GNAT_NIP_DIST = 1.3;         // nip contact range
export const GNAT_NIP_DAMAGE = 3;         // mosquito-tier - insult, not injury
export const GNAT_NIP_FORCE = 2;
export const GNAT_NIP_CD = 2.2;           // per-gnat cooldown between darts
export const GNAT_FLOCK_CD = 0.7;         // min spacing between ANY two darts
export const GNAT_STUN = 0.3;

// Turretter - plants as a turret, lobs itself at the player on a perfect
// ballistic arc when they get far. Inert in flight: the hop IS the
// shoot-it window.
export const TURRET_MAX = 3;
// Turretter creature params - NOT the sentry deployable (that range/damage
// lives in shared/deployItems.ts as DEPLOY_ITEMS.turret.*).
export const TURRET_SPAWN_INTERVAL = 12; // spawn attempts are slow - they're persistent threats
export const TURRET_SPAWN_MIN = 60;
export const TURRET_SPAWN_MAX = 120;
export const TURRET_RADIUS = 1.2;
export const TURRET_HEALTH = 300;         // planted halves incoming damage, airborne doubles it
export const TURRET_RANGE = 65;         // fires bolts inside this
export const TURRET_RELAUNCH = 75;      // beyond this → ballistic hop at you
export const TURRET_MIN_DWELL = 3;      // must sit planted this long between hops (no ping-pong)
export const TURRET_HOP_T = 1.6;          // solved flight time of the launch arc
export const TURRET_REFIRE = 1.6;         // s between bolts
export const TURRET_BOLT_SPEED = 60;    // m/s muzzle speed - elevation solved per shot
export const TURRET_DEPRESS = 0.087;      // ~5° below horizontal - muzzle kisses the hull rim past this
export const TURRET_BOLT_DAMAGE = 12;

// Roller - a big ball that just rolls at you. No hops, no brains:
// terrain-following homing boulder. Hitbox is the threat.
export const ROLLER_SPAWN_INTERVAL = 8;
export const ROLLER_SPAWN_MIN = 50;
export const ROLLER_SPAWN_MAX = 110;
export const ROLLER_RADIUS = 1.6;        // decently big
export const ROLLER_HEALTH = 200;
export const ROLLER_ACCEL = 14;        // m/s² steering toward the player
export const ROLLER_TOPSPEED = 26;     // downhill it can exceed via gravity
export const ROLLER_HIT_DAMAGE = 18;
export const ROLLER_HIT_FORCE = 22;      // shove on contact

// Tumbleweed - destructible rolling props. Wind-blown (same drift direction
// as the ambient dust), bounce off slopes, pop into twigs when shot.
export const WEED_SPAWN_INTERVAL = 2.5;
export const WEED_SPAWN_MIN = 40;      // spawn upwind of the player…
export const WEED_SPAWN_MAX = 70;
export const WEED_KILL_DIST = 110;     // …despawn once blown this far past
export const WEED_RADIUS = 1.5;
export const WEED_HEALTH = 25;           // pops to any direct hit
export const WEED_SPEED = 7;           // cruise speed downwind
export const WEED_WIND_X = 1.4;          // same wind vector as ambientParticles
export const WEED_WIND_Z = 0.6;
export const WEED_HOP = 3;             // bounce impulse cresting bumps

// Seeker - airborne skull-wasp. Ignores terrain while cruising above it,
// commits to a telegraphed straight-line dart (the dodge window IS the
// design), stings on contact, then drifts off to recover.
export const SEEKER_SPAWN_INTERVAL = 7;
export const SEEKER_SPAWN_MIN = 35;
export const SEEKER_SPAWN_MAX = 70;
export const SEEKER_RADIUS = 0.6;
export const SEEKER_HEALTH = 70;
export const SEEKER_AGGRO_DIST = 45;
export const SEEKER_HOVER = 5;        // cruise height above terrain
export const SEEKER_SPEED = 16;       // chase top speed
export const SEEKER_ACCEL = 22;
export const SEEKER_DART_RANGE = 11;  // telegraph triggers inside this
export const SEEKER_DART_SPEED = 32;
export const SEEKER_DART_TELEGRAPH = 0.4; // rear-back pause before launch
export const SEEKER_DART_MAX = 0.8;     // committed dash duration
export const SEEKER_STING_DIST = 1.8;   // contact damage range
export const SEEKER_STING_DAMAGE = 10;  // server-authoritative self-damage
export const SEEKER_STING_FORCE = 14;   // shove on sting
export const SEEKER_RECOVER = 1.2;      // post-dart drift-away window
export const SEEKER_STUN = 0.6;         // blast knockback suppresses attacks this long

// Overlord - the flying dredge: a big slow gasbag that circles the player and
// sows mines across the dunes. Always visible, huge hitbox, high HP - a
// priority target, not a lurker. The mine trail punishes ignoring it.
export const OVERLORD_SPAWN_INTERVAL = 20; // slow - a persistent menace, not a swarm
export const OVERLORD_SPAWN_MIN = 60;
export const OVERLORD_SPAWN_MAX = 100;
export const OVERLORD_RADIUS = 2.2;
export const OVERLORD_HEALTH = 400;
export const OVERLORD_SPEED = 5;         // ponderous drift
export const OVERLORD_ACCEL = 3;
export const OVERLORD_ALTITUDE = 11;     // cruise height above terrain
export const OVERLORD_LOITER_DIST = 30;  // ring radius it circles the player at
export const OVERLORD_DROP_INTERVAL = 2.8; // seconds between mine drops
export const OVERLORD_DROP_RANGE = 50;   // only sows inside the player's play space
export const OVERLORD_STUN = 0.4;          // blast knockback stalls its steering

// Mines - the droppings. Shootable (detonating one clears it), proximity-fused.
export const MINE_RADIUS = 0.5;
// Combat envelope derives from the shared belt registry - the fuse,
// blast and damage numbers must match the server's authoritatively;
// MINE_LIFE stays local (overlord-field balance, not the wire ttl).
export const MINE_ARM_TIME = DEPLOY_ITEMS.mine.armS!;
export const MINE_TRIGGER_DIST = DEPLOY_ITEMS.mine.triggerDist!;
export const MINE_BLAST_RADIUS = DEPLOY_ITEMS.mine.blastRadius!;
export const MINE_DAMAGE_MAX = DEPLOY_ITEMS.mine.blastDamage!;
export const MINE_KNOCKBACK = DEPLOY_ITEMS.mine.knockback!;
export const MINE_LIFE = 45;          // seconds before it fizzle-pops

// Banelings - rolling suicide bombs birthed by the Overlord (was: Overlord)
export const BANELING_RADIUS = 0.7;      // small - an exploding sac, not a boulder
export const BANELING_HEALTH = 15;       // pops to a couple of hits
export const BANELING_ACCEL = 22;      // zippy homing
export const BANELING_TOPSPEED = 20;
export const BANELING_FUSE_DIST = 2.6;   // proximity fuse
export const BANELING_BLAST_RADIUS = 5;
export const BANELING_DAMAGE_MAX = 18;   // at zero distance
export const BANELING_KNOCKBACK = 14;
export const BANELING_LIFE = 25;       // self-detonates eventually

// Totem - peak-seeking sniper obelisk. Blinks to local high ground, charges
// a visible aim-beam, fires a fast flat bolt. Relocates when crowded,
// when LOS is blocked, or after a few shots - it always wants the crest.
export const TOTEM_SPAWN_INTERVAL = 18; // rare - a persistent ranged threat
export const TOTEM_SPAWN_MIN = 50;
export const TOTEM_SPAWN_MAX = 95;    // inside readable fog distance
export const TOTEM_RADIUS = 1;
export const TOTEM_HEALTH = 200;
export const TOTEM_RANGE = 105;       // engages inside the fog line - sniping from beyond it reads as invisible cheating
export const TOTEM_MIN_RANGE = 22;    // player closer than this → blink away
export const TOTEM_REFIRE = 2.6;        // seconds between shots
export const TOTEM_BOLT_DAMAGE = 15;
export const TOTEM_CHARGE = 0.65;       // aim-beam telegraph - dodgeable, not free
export const TOTEM_RELOCATE_HOPS = 3;   // shots fired before seeking a new perch
export const TOTEM_PEAK_RADIUS = 45;  // how far it samples terrain for peaks
export const TOTEM_PEAK_MIN_GAIN = 3; // min height gain to count as "better perch"
export const TOTEM_MATERIALIZE = 0.7;   // post-blink vulnerable window

// Uber totem - the elite sniper. Bigger, tankier, slower to fire, but it
// LEADS you: the beam locks pos + vel × charge, so holding a strafe line
// gets you tagged. The only dodge is changing direction after the lock.
export const UBER_TOTEM_MAX = 1;          // one at a time - it's a named threat

// Rare "uber" variants - every ambient (non-event) enemy spawn rolls this.
// Ubers are bigger, tankier, and carry one unique hook; they never REPLACE
// the base species, they just occasionally show up instead.
export const UBER_CHANCE = 0.07;          // ~1 in 14 ambient spawns is an uber
export const UBER_TOTEM_RADIUS = 1.8;     // nearly double the obelisk
export const UBER_TOTEM_HEALTH = 500;
export const UBER_TOTEM_REFIRE = 4.5;     // slow, deliberate, devastating
export const UBER_TOTEM_CHARGE = 1;     // long telegraph - your juke window
export const UBER_TOTEM_BOLT_DAMAGE = 30;
export const UBER_TOTEM_HIT_RADIUS = 1.5; // beam catch envelope vs 1.7²≈1.3 normal
export const UBER_TOTEM_BEAM_WIDTH = 1.2; // fat red telegraph - reads "death ray"

// Rakk - the cliff-racer. Soars overhead in lazy circles, folds its wings,
// and swoops a gliding pass through the player. Flock attack token keeps
// it to one diver at a time; the slow climb-out is the shoot-it window.
export const RAKK_SPAWN_INTERVAL = 9;
export const RAKK_SPAWN_MIN = 40;
export const RAKK_SPAWN_MAX = 80;
export const RAKK_RADIUS = 1.1;
export const RAKK_HEALTH = 100;
export const RAKK_ORBIT_ALT = 22;     // cruise height above terrain
export const RAKK_ORBIT_R = 25;       // circling radius around the player
export const RAKK_SPEED = 18;         // soar speed
export const RAKK_ACCEL = 18;
export const RAKK_DIVE_CD_MIN = 3;    // seconds between dive opportunities
export const RAKK_DIVE_CD_MAX = 7;
export const RAKK_DIVE_SPEED = 40;    // fold-and-scream speed
export const RAKK_CLAW_DIST = 2.2;      // pass-through contact range
export const RAKK_CLAW_DAMAGE = 12;
export const RAKK_CLAW_FORCE = 10;      // shove on hit
export const RAKK_CLIMB_T = 2.2;        // the slow vulnerable climb-out
export const RAKK_STUN = 0.5;

// Buzzard - server-owned species (shared/species.ts 'buzzard', family
// 'fly'): the ambient kettle made a real hazard. Map `creatures` pops
// mint them; there is no local spawn path.
export const BUZZARD_RADIUS = 1;
export const BUZZARD_ORBIT_ALT = 16;    // cruise height above terrain

// Strifer - standoff strafing drone: orbits you at range, hovers to volley
export const STRIFER_RADIUS = 0.9;
export const STRIFER_HEALTH = 55;
export const STRIFER_ORBIT_ALT = 14;    // lower than rakk - it wants line of fire
export const STRIFER_ORBIT_R = 34;      // standoff ring - outside melee reach
export const STRIFER_SPEED = 22;
export const STRIFER_ACCEL = 20;
export const STRIFER_REFIRE_MIN = 4;    // seconds of orbiting between volleys
export const STRIFER_REFIRE_MAX = 8;
export const STRIFER_HOVER_T = 3;       // max hover window
export const STRIFER_BOLT_SPEED = 55;
export const STRIFER_BOLT_LIFE = 3;
export const STRIFER_BOLT_DIST = 1.6;     // bolt contact radius
export const STRIFER_BOLT_DAMAGE = 9;
export const STRIFER_BOLT_FORCE = 5;      // bolt impact shove
export const STRIFER_STUN = 0.6;
export const STRIFER_SPAWN_INTERVAL = 11;
export const STRIFER_SPAWN_MIN = 45;
export const STRIFER_SPAWN_MAX = 90;

// Camera constants
export const CAMERA_FOV = 90; // Field of view in degrees
export const CAMERA_NEAR = 0.05; // Near clipping plane - small value to prevent terrain clipping at screen corners on steep slopes
export const CAMERA_FAR = 6000; // Far clipping plane

// Fog constants
export const FOG_COLOR = 0xBB_D0_E8; // Fog and clear color (matches sky haze horizon)
export const FOG_START = 120; // Linear fog start distance
export const FOG_END = 600; // Linear fog end distance

// Atmospheric sky constants (physical Rayleigh/Mie scattering - glsl-atmosphere)
export const SKY_TURBIDITY = 10;
export const SKY_RAYLEIGH = 1; // Multiplier on Earth Rayleigh coefficients
export const SKY_MIE_COEFFICIENT = 21e-6; // Earth Mie scattering coefficient
export const SKY_MIE_DIRECTIONAL_G = 0; // 0 = isotropic - no sunward glow blob (was 0.758)
export const SKY_RAYLEIGH_DIRECTIONAL = 0; // 0 = flat dipole - no bright/dim sky sides (was 1)
export const SKY_SUN_INTENSITY = 22; // Sun radiance for scattering (not a visible disc)

// Volumetric cloud constants
// Layered-deck + billboard hybrid shelved for now - visuals weren't
// landing ("flat roof + blobs"). Code kept in volumetricClouds.ts; flip
// this back on or use ?clouds=on to re-enable without reverting.
export const CLOUDS_ENABLED = false;
export const CLOUD_COUNT = 30; // Number of cloud clusters
export const CLOUD_DENSITY = 0.35; // Cloud density
export const CLOUD_WIND_SPEED = 3; // Wind speed
export const CLOUD_MIN_HEIGHT = 500; // Minimum cloud height
export const CLOUD_MAX_HEIGHT = 900; // Maximum cloud height
export const CLOUD_SPREAD_RADIUS = 4000; // Cloud spread radius

// Lighting constants
export const AMBIENT_COLOR = 0x88_66_44; // Ambient light color
export const AMBIENT_INTENSITY = 0.35; // Ambient light intensity - lower fill deepens shading
export const SUN_COLOR = 0xFF_E8_AA; // Sun light color
export const SUN_INTENSITY = 3.2; // Sun light intensity
export const SHADOW_MAP_SIZE = 2048; // Shadow map resolution
export const SHADOW_CAMERA_NEAR = 1; // Shadow camera near plane
export const SHADOW_CAMERA_FAR = 2000; // Shadow camera far plane
export const SHADOW_CAMERA_SIZE = 130; // Shadow camera half-extent - follows the camera; ~0.13m/texel at 2048². Measured on the 3070Ti bench: 250m box → 681 shadow-pass draw calls; ~130m cuts the caster count ~4× while distant shadows are unreadable anyway.
export const HEMI_SKY_COLOR = 0x55_99_CC; // Hemisphere sky color
export const HEMI_GROUND_COLOR = 0x66_44_22; // Hemisphere ground color
export const HEMI_INTENSITY = 0.5; // Hemisphere light intensity

// Network constants
export const FRAG_MESSAGE_DURATION = 2000; // Milliseconds to show frag message
export const FRAG_MESSAGE_FADE = 500; // Milliseconds for frag message fade transition



// Renderer constants
export const TONE_MAPPING_EXPOSURE = 0.4; // Tone mapping exposure (lower = darker)
export const BLOOM_LAYER = 7; // objects on this layer feed the bloom buffer (trails, explosions)
// Emitter colors get written HDR-hot (×EMIT_GAIN) into the composer buffer
// so they clear the bloom luminance threshold; ACES saturates them back to
// the same display hue - the glow comes from bloom, not a washed-out frame.
export const EMIT_GAIN = 3;



// Explosion physics constants
export const KNOCKBACK_MULTIPLIER = 0.4; // Knockback force multiplier
export const PULL_MULTIPLIER = 0.5; // Pull force multiplier

// Accuracy constants
export const ACCURACY_MAX = 10; // Maximum accuracy score
export const ACCURACY_NORMALIZATION = 8; // Accuracy normalization divisor

// Game loop constants
export const MAX_DELTA_TIME = 0.05; // Maximum delta time in seconds
export const REMOTE_PLAYER_FIXED_DT = 0.016; // Fixed delta time for remote player updates
export const DEBUG_LOG_SAMPLE_RATE = 0.05; // 5% of updates log for debugging

// Player constants
export const MAX_HEALTH = 100; // Maximum player health

// Remote player rendering: snapshot interpolation at a fixed delay
// (INTERP_DELAY lives on RemotePlayer - covers ~2 missed 20Hz packets)

// Effect constants

// Terrain constants
export const TERRAIN_HEIGHT_SCALE = 125; // Terrain height scale
export const TERRAIN_WORLD_SCALE = 1500; // Terrain world scale
export const TERRAIN_HEIGHTMAP_DIVISOR = 255; // Heightmap value divisor
// Sediment lips - structures mound the DRAWN field around their bases.
// Visual-only (collision/sim read the raw field). ?nolips kills it at
// runtime for A/B without reverting.
export const TERRAIN_STRUCTURE_LIPS = true;

// Networking backend configuration
// Options: 'tribes2' (Tribes2-style with bit-packing for LAN-like gameplay), 'fastapi' (Simple JSON-based WebSocket)
// Networking: single WebSocket transport - see networking/ + shared/wire.ts

// Tribes2 networking constants (per multiplayer specification)
export const WS_RECONNECT_INTERVAL = 3000; // WebSocket reconnection interval (ms)

