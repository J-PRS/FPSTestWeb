// Per-weapon stat rows - the data half of weaponTable.ts. Split out so the
// Rows part B - split of weaponRows.ts (file-size watch ceiling). The
// exported WEAPONS object in weaponRows.ts spreads A+B; append new
// weapons here or rebalance the split when this file nears ~900.
import { WeaponType, type WeaponStats } from './weaponTable.ts';
export const WEAPONS_B: Record<number, WeaponStats> = {
  [WeaponType.Sprinkler]: {
    aimAxis: 'track',
    fireInterval: 0.1,

    // Sprinkler: plasma-gun cadence (~10/s ≈ 140dps on paper) but every bolt
    // arcs under world gravity inside a slight cone - mid-range area
    // denial, not a dueling laser. Lower direct damage + tiny pop so the
    // stream rewards saturation over precision.
    directDamage: 12,
    aoeDamage: 5,
    aoeRadius: 3,
    knockbackForce: 9,
    forceMode: 'push',
    speed: 120,    // slower than plasma's 160 - an arc needs airtime to read
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 1.2,
    hitGrow: 0.3,
    maxLifetime: 3, // arcs need hang time - ~1.9s to reach a 60m lob
  },
  [WeaponType.Slam]: {
    // Not a projectile - the Q-skill lands as a ground AOE. Ballistic
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
    // Hitscan repair beam - the sting vs creatures exists so the tool
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
    sidearm: true,
  },
  [WeaponType.ArmorGrenade]: {
    fireInterval: 1,
    // Support ordnance: the blast is deliberately mid - the payoff is the
    // plating it sprays onto EVERYTHING it catches (players via the armor
    // pool, creatures as overcap health). Arming the enemy is the cost of
    // plating your own push - see ARMORNADE_* below.
    directDamage: 0,
    aoeDamage: 40,
    aoeRadius: 10,
    knockbackForce: 25, // a nudge, not a launcher - the plating is the payload
    forceMode: 'push',
    speed: 40,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0,
    hitMax: 0.25, // belt rule - plating lands on contact, not a fat wake
    hitGrow: 2,
    maxLifetime: 2,
  },
  [WeaponType.HealBeam]: {
    fireInterval: 0.1,
    // Hitscan heal - the payload is HP on a friend, not damage. directDamage
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
    fireInterval: 1,
    // Heal burst: tight radius, the sting vs enemies is the tax on a
    // misthrow - allies get the strong heal, foes get a shove + graze.
    directDamage: 0,
    aoeDamage: 12,
    aoeRadius: 6,
    knockbackForce: 22,
    forceMode: 'push',
    speed: 40,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0,
    hitMax: 0.25, // belt rule - the heal pops on real contact or the fuse
    hitGrow: 2,
    maxLifetime: 2,
  },
  [WeaponType.ProxyGrenade]: {
    fireInterval: 1,
    // Proximity-fused zone pop: a 1s fuse whose trigger bubble inflates
    // 0→4m over its whole life - the closer it is to popping, the wider
    // the net. Toss it into a fight and it cooks off the moment anyone
    // wanders into the bubble (or the fuse lands anyway).
    directDamage: 35,
    aoeDamage: 30,
    aoeRadius: 6,
    knockbackForce: 22,
    forceMode: 'push',
    speed: 40,   // thrown lob - enough to clear a doorway, not a dart
    gravity: true,
    bodyRadius: 0.22,
    hitMin: 0,
    hitMax: 4,   // the proxy bubble ceiling - 4m radius at fuse end
    hitGrow: 1,  // grows for the whole 1s life - full width AT the pop
    maxLifetime: 1,
  },
  [WeaponType.SatchelCharge]: {
    fireInterval: 1.9,
    // Satchel charge: hand-planted bomb, not a grenade. Near-zero throw
    // speed means you have to BE there - brush past a generator or an
    // enemy's back, slap it on, and it glues in place for a slow 4s fuse.
    // The payoff is the biggest belt blast in the kit.
    directDamage: 150,
    aoeDamage: 130,
    aoeRadius: 17,
    knockbackForce: 75,
    forceMode: 'push',
    speed: 10,    // an underhand lob - a few meters of range, no tossing over walls
    gravity: true,
    bodyRadius: 0.28,
    hitMin: 0,
    hitMax: 0,   // NO proxy wake - a planted charge only sticks on true contact
    hitGrow: 0.1,  // >0 so hitRadiusAt never divides by zero; hitMax 0 makes it moot
    maxLifetime: 4, // THE fuse - long enough to walk away, short enough the victim hears it
    stick: true,   // hand-planted: rests where it lands until the fuse
  },
  [WeaponType.MRVLauncher]: {
    aimAxis: 'arcLead',
    fireInterval: 2.4,
    tier: 'heavy',

    // Mortar's counterpart: a bouncing carrier shell that AIRBURSTS at
    // ~1s into bomblets - one volley in one direction (MRV, not MIRV:
    // the bomblets scatter, they're not independently targeted). The
    // carrier's own pop is small; the bomblet rain is the weapon.
    directDamage: 30,
    aoeDamage: 15,
    aoeRadius: 8,
    knockbackForce: 15, // the pop is delivery - the rain does the shoving
    forceMode: 'push',
    speed: 80,          // mortar muzzle - same lob line, different payload
    gravity: true,
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 0.5,          // bombardment weapon - no fat wake proxy, the rain is the reach
    hitGrow: 0.5,
    maxLifetime: 1.5,     // fuse pop releases the bomblets mid-air - ~80m of carry before the split
    fuseOnly: true,       // bodies don't pop it - a 55 m/s contact shell that
                        // also rains bomblets is a strictly-better mortar
    terrainBounce: true,  // skips along until the fuse - the airburst needs the carry
    bounceRestitution: 0.35, // = client MRV_BOUNCE_RESTITUTION
    bounceFriction: 0.7,
    cluster: { count: 6, radius: 5 }, // bomblet scatter footprint at the burst point
  },
  [WeaponType.MRVBomblet]: {
    // Airburst child - contact pop on whatever it rains onto. Count is
    // the weapon: 6 × ~29 max ≈ a mortar's worth spread over an area.
    // 16m ring: six overlapping footprints make a real denial field -
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
    hitMax: 0.5,          // bomblets must LAND - a big proxy would pop them mid-air on anything nearby
    hitGrow: 1,
    maxLifetime: 10,    // safety TTL only - contact pops them; an air fuse wastes the rain
  },
  [WeaponType.Bombard]: {
    aimAxis: 'arcLead',
    fireInterval: 1.6,
    gib: true, tier: 'heavy',
    // The cannon's bigger, meaner brother: an even fatter iron ball that
    // NEVER detonates - it shatters into shards on contact (terrain,
    // walls, shields, bodies; no arm window). The crumble carries a small
    // standard 2m splash sphere, so a near-miss at the contact point still
    // tags - a plain reliable sphere, NOT a shard cone. The player
    // envelope rides directDamage (splash is a fraction of the direct line
    // by convention).
    directDamage: 140,   // tops every primary - and the only headline
                         // number actually landable on a body: Mortar's
                         // 120 is fuse-gated (armTime 1.5s ≈ 82m), its
                         // real ceiling is the 100 inner splash ring.
                         // The planted satchel (150) still owns the
                         // overall record; also the shrapnel ceiling.
    aoeDamage: 140,      // wildlife splash mirrors the player envelope -
                         // a shard is a shard regardless of what it hits
    aoeRadius: 2,        // tiny, reliable tag: the contact point and
                         // nothing more. (A 9m shard cone read as
                         // unreliable - most of it never connected.)
    knockbackForce: 12,  // shard thump - staggers, doesn't launch
    forceMode: 'push',
    speed: 100,        // faster than the cannon's 80 - a flat siege slug, not a lob
    gravity: true,
    bodyRadius: 1.05,    // HUGE - visibly wider than the 0.8 cannonball
    hitMin: 0,
    hitMax: 1.5,         // modest proxy - a siege slug earns contact, not a 2m wake
    hitGrow: 0.5,
    maxLifetime: 6,    // ~570m of carry before the fuse crumbles it mid-air
    // Bounce SHELVED (it felt strictly worse): maxBounces 0 disables the
    // skip - the slug crumbles on first dirt contact, as before. The skip
    // fields stay so it can be re-tried by setting maxBounces 1.
    terrainBounce: true,
    bounceRestitution: 0.5,
    bounceFriction: 0.5,
    maxBounces: 0,
  },
  [WeaponType.Hook]: {
    fireInterval: 1,
    // Rope dart: contact is never a blast - hitting a body reels the
    // victim toward the shooter, hitting anything else reels the shooter
    // toward the anchor (the movement tool). No damage, no splash: the
    // yank IS the payload, so aoe fields stay zero and `hook` marks the
    // detonation branch both sims take.
    directDamage: 0,
    aoeDamage: 0,
    aoeRadius: 0,
    knockbackForce: 18, // the reel - a firm snap, no falloff: flat hits
    //   harder per point than any blast (disc-jump 45 only peaks there at
    //   the T1 curve's sweet spot), so 18 lands ~half a good disc jump.
    forceMode: 'pull',
    speed: 110,   // a thrown line reads fast - slower and skiers outrun it
    gravity: false, // ropes fly flat - a drooping line can't reach what you aimed at
    bodyRadius: 0.3,
    hitMin: 0,
    hitMax: 1.2, // a rope snags, doesn't pierce - the grab window IS the weapon
    hitGrow: 0.15,
    maxLifetime: 0.45, // ~50m of rope - past that the line snaps mid-flight
    hook: true,
  },
  [WeaponType.EMP]: {
    // EMP grenade: belt throw fuse bomb - nominal 10 tag on contact, drains
    // all jet energy and strips shield for targets in the blast radius.
    // Timer detonation (not proxy/hit) to avoid being OP.
    directDamage: 10,
    aoeDamage: 0,
    aoeRadius: 12,
    knockbackForce: 0,
    forceMode: 'push',
    speed: 35,
    gravity: true,
    bodyRadius: 0.25,
    hitMin: 0,
    hitMax: 0.25,
    hitGrow: 2,
    maxLifetime: 2, // 2s fuse - timer detonation
    armTime: 2, // never arms - same never-pops-on-contact contract as Grenade
    terrainBounce: true,
    bounceRestitution: 0.5,
    bounceFriction: 0.7,
    beltThrow: true,
    fireInterval: 1,
  },
};
