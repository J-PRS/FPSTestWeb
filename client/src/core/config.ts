export const GRAVITY = -28.0;

// Physics constants for debris and death physics
export const BOUNCE_Y = 0.35; // Vertical bounce coefficient
export const FRICTION_XZ = 0.80; // Horizontal friction coefficient
export const SHRINK_DUR = 0.5; // Debris shrink duration
export const GREY_DUR = 1.0; // Debris grey fade duration
export const BASE_SPEED = 9.0; // Base debris speed
export const EXTRA_SPEED = 14.0; // Extra random debris speed
export const LIFE_BASE = 6.0; // Base debris lifetime
export const LIFE_RAND = 2.0; // Random debris lifetime variation

// Player capsule geometry lives in shared/constants.ts — the server needs
// the same numbers to validate hit claims against networked positions.
export {
  PLAYER_RADIUS, PLAYER_HEIGHT,
  CAPSULE_CYLINDER_HEIGHT, CAPSULE_HALF_HEIGHT, CAPSULE_CENTER_Y,
  EYE_OFFSET,
} from '../../../shared/constants.js';

// Player jetpack constants
export const JET_FORCE_UP = 35.0; // Vertical jetpack force
export const JET_FORCE_DIR = 10.0; // Lateral jetpack control
export const MAX_ENERGY = 60.0; // Maximum jetpack energy
export const JET_DRAIN = 15.0; // Energy drain per second
export const JET_CHARGE = 8.0; // Energy recharge per second

// Weapon constants
export const FIRE_RATE = 0.8; // Rocket fire rate (seconds)
export const DISC_RATE = 1.0; // Disc fire rate (seconds)
export const GRENADE_RATE = 1.2; // Grenade fire rate (seconds)
export const CHAINGUN_RATE = 0.09; // Chaingun fire rate (seconds)

// Projectile gameplay stats (speed, gravity, hitboxes, damage, fuse) live in
// shared/weapons.ts — the single source of truth the server validates with.
// The constants that remain here are visual/VFX scales only.
export const ROCKET_RADIUS = 6.0; // Rocket explosion radius (visual)

// Disc constants
export const DISC_RADIUS = 5.0; // Disc explosion radius (visual)

// Grenade constants
export const GRENADE_RADIUS = 10.0; // Grenade explosion radius (visual)

// Mortar — T1/T2 heavy siege shell: slow lob, the biggest splash in the game
export const MORTAR_RATE = 2.0; // Mortar fire rate — T2 is 0.5 rounds/sec

// Grenade launcher — T2 style: bouncing timed shells, explode on player contact
export const GL_RATE = 0.7; // Grenade launcher fire rate (seconds)
export const GL_BOUNCE_RESTITUTION = 0.55; // Energy kept on the normal axis
export const GL_BOUNCE_FRICTION = 0.7; // Tangential damping per bounce

// Flak cannon — UT style: a spray of bouncing shards, direct-hit only
export const FLAK_RATE = 1.1; // Flak fire rate (seconds)
export const FLAK_SHARDS = 9; // Shards per shell
export const FLAK_SPREAD = 0.10; // Cone half-angle (radians-ish slope factor)
export const FLAK_MAX_BOUNCES = 3; // Shards die on the Nth terrain hit
export const FLAK_BOUNCE_RESTITUTION = 0.6;
export const FLAK_BOUNCE_FRICTION = 0.8;

// Plasma gun — T1/T2 fat energy bolt, sustained midrange fire
export const PLASMA_RATE = 0.28; // ~3.5 rps

// Game constants
export const BALL_SPAWN_INTERVAL = 2.5; // Seconds between ball spawns

// Ball constants
export const BALL_MAX_DIST = 300.0; // Maximum distance before teleport
export const BALL_TELE_MIN = 60.0; // Minimum teleport distance
export const BALL_TELE_MAX = 120.0; // Maximum teleport distance
export const BALL_TELE_HEIGHT = 25.0; // Teleport height
export const BALL_MAX = 10; // Maximum number of balls in play

// Ball enrage mode: instead of teleporting when out of range, far balls get
// angry and are pulled toward the player while still bouncing normally
export const BALL_ENRAGE_ENABLED = true; // Toggle: enrage instead of teleport
export const BALL_ENRAGE_FORCE = 12.0; // Linear attraction accel toward player (m/s^2)
// Balls stay enraged until they get a lunge off (or time out) — no distance
// cooldown, otherwise they'd always calm before reaching dash range
export const BALL_ENRAGE_TIMEOUT = 20.0; // Seconds enraged before teleport fallback
export const BALL_ENRAGE_DASH_DIST = 100.0; // Ground hit within this XZ range becomes a lunge
export const BALL_ENRAGE_DASH_SPEED = 45.0; // Lunge speed toward the player
export const BALL_ENRAGE_TELEGRAPH_H = 8.0; // Glow ramps to white under this height in dash range

// Crawlers — terrain-hugging targets that hop, chase, and pounce
export const CRAWLER_MAX = 6; // Max crawlers alive
export const CRAWLER_SPAWN_INTERVAL = 4.0; // Seconds between spawn attempts
export const CRAWLER_SPAWN_MIN = 40.0; // Spawn ring: min distance from player
export const CRAWLER_SPAWN_MAX = 90.0;
export const CRAWLER_RADIUS = 0.9;
export const CRAWLER_HEALTH = 2;
export const CRAWLER_AGGRO_DIST = 70.0; // Chases inside this range
export const CRAWLER_POUNCE_DIST = 25.0; // Ground inside this range → windup → pounce
export const CRAWLER_WINDUP = 0.35; // Crouch telegraph before pounce (s)
export const CRAWLER_HOP_SPEED = 10.0; // Chase hop horizontal speed
export const CRAWLER_HOP_UP = 5.0; // Hop vertical kick
export const CRAWLER_POUNCE_SPEED = 30.0; // Pounce horizontal speed
export const CRAWLER_POUNCE_DAMAGE = 25; // Server-authoritative self-damage on pounce hit
export const CRAWLER_STUN = 0.5; // Blast knockback suppresses hopping this long

// Turretter — plants as a turret, lobs itself at the player on a perfect
// ballistic arc when they get far. Inert in flight: the hop IS the
// shoot-it window.
export const TURRET_MAX = 3;
export const TURRET_SPAWN_INTERVAL = 12.0; // spawn attempts are slow — they're persistent threats
export const TURRET_SPAWN_MIN = 60.0;
export const TURRET_SPAWN_MAX = 120.0;
export const TURRET_RADIUS = 1.2;
export const TURRET_HEALTH = 6;           // hit-count; planted halves incoming damage
export const TURRET_RANGE = 65.0;         // fires bolts inside this
export const TURRET_RELAUNCH = 75.0;      // beyond this → ballistic hop at you
export const TURRET_MIN_DWELL = 3.0;      // must sit planted this long between hops (no ping-pong)
export const TURRET_HOP_T = 1.6;          // solved flight time of the launch arc
export const TURRET_REFIRE = 1.6;         // s between bolts
export const TURRET_BOLT_SPEED_T = 0.9;   // bolt flight time — the arc solver's knob
export const TURRET_BOLT_DAMAGE = 12;

// Roller — a big ball that just rolls at you. No hops, no brains:
// terrain-following homing boulder. Hitbox is the threat.
export const ROLLER_MAX = 4;
export const ROLLER_SPAWN_INTERVAL = 8.0;
export const ROLLER_SPAWN_MIN = 50.0;
export const ROLLER_SPAWN_MAX = 110.0;
export const ROLLER_RADIUS = 1.6;        // decently big
export const ROLLER_HEALTH = 4;
export const ROLLER_ACCEL = 14.0;        // m/s² steering toward the player
export const ROLLER_TOPSPEED = 26.0;     // downhill it can exceed via gravity
export const ROLLER_HIT_DAMAGE = 18;
export const ROLLER_HIT_FORCE = 22;      // shove on contact

// Renderer constants
export const PIXEL_SCALE = 4; // Each pixel is 4x4 screen pixels (Doom-style)
export const RENDERER_PIXEL_RATIO = 1; // Device pixel ratio

// Camera constants
export const CAMERA_FOV = 90; // Field of view in degrees
export const CAMERA_NEAR = 0.05; // Near clipping plane — small value to prevent terrain clipping at screen corners on steep slopes
export const CAMERA_FAR = 6000; // Far clipping plane

// Fog constants
export const FOG_COLOR = 0xbbd0e8; // Fog and clear color (matches sky haze horizon)
export const FOG_START = 120.0; // Linear fog start distance
export const FOG_END = 600.0; // Linear fog end distance

// Atmospheric sky constants (physical Rayleigh/Mie scattering — glsl-atmosphere)
export const SKY_TURBIDITY = 10.0;
export const SKY_RAYLEIGH = 1.0; // Multiplier on Earth Rayleigh coefficients
export const SKY_MIE_COEFFICIENT = 21e-6; // Earth Mie scattering coefficient
export const SKY_MIE_DIRECTIONAL_G = 0.758; // Mie forward-scatter directionality
export const SKY_SUN_INTENSITY = 22.0; // Sun radiance for scattering (not a visible disc)

// Volumetric cloud constants
export const CLOUD_COUNT = 30; // Number of cloud clusters
export const CLOUD_DENSITY = 0.35; // Cloud density
export const CLOUD_WIND_SPEED = 3.0; // Wind speed
export const CLOUD_MIN_HEIGHT = 500; // Minimum cloud height
export const CLOUD_MAX_HEIGHT = 900; // Maximum cloud height
export const CLOUD_SPREAD_RADIUS = 4000; // Cloud spread radius
export const CLOUD_DEFAULT_COUNT = 50; // Default cloud cluster count
export const CLOUD_DEFAULT_WIND_SPEED = 5.0; // Default wind speed
export const CLOUD_DEFAULT_DENSITY = 0.4; // Default cloud density
export const CLOUD_SPHERES_PER_CLOUD = 10; // Spheres per cloud cluster
export const CLOUD_DEFAULT_MIN_HEIGHT = 400; // Default minimum height
export const CLOUD_DEFAULT_MAX_HEIGHT = 800; // Default maximum height
export const CLOUD_DEFAULT_SPREAD_RADIUS = 3000; // Default spread radius
export const CLOUD_WIND_OFFSET_RANGE = 100; // Wind offset random range
export const CLOUD_POSITION_RANGE_XZ = 150; // Position random range X/Z
export const CLOUD_POSITION_RANGE_Y = 50; // Position random range Y
export const CLOUD_SCALE_MIN = 30; // Minimum cloud sphere scale
export const CLOUD_SCALE_RANGE = 70; // Cloud sphere scale range

// Lighting constants
export const AMBIENT_COLOR = 0x886644; // Ambient light color
export const AMBIENT_INTENSITY = 0.5; // Ambient light intensity
export const SUN_COLOR = 0xffe8aa; // Sun light color
export const SUN_INTENSITY = 3.2; // Sun light intensity
export const SHADOW_MAP_SIZE = 2048; // Shadow map resolution
export const SHADOW_CAMERA_NEAR = 1; // Shadow camera near plane
export const SHADOW_CAMERA_FAR = 2000; // Shadow camera far plane
export const SHADOW_CAMERA_SIZE = 1200; // Shadow camera frustum size (covers 400 unit ball spawn radius)
export const HEMI_SKY_COLOR = 0x5599cc; // Hemisphere sky color
export const HEMI_GROUND_COLOR = 0x664422; // Hemisphere ground color
export const HEMI_INTENSITY = 0.5; // Hemisphere light intensity

// Network constants
export const PENDING_ROCKET_TIMEOUT = 3000; // Milliseconds to wait for server projectile ID
export const FRAG_MESSAGE_DURATION = 2000; // Milliseconds to show frag message
export const FRAG_MESSAGE_FADE = 500; // Milliseconds for frag message fade transition
export const BALL_BASE_RADIUS = 1.2; // Base ball radius

// Input/prediction constants
export const MAX_INPUT_HISTORY = 100; // Maximum input history entries for replay

// Renderer constants
export const TONE_MAPPING_EXPOSURE = 0.4; // Tone mapping exposure (lower = darker)
export const BLOOM_LAYER = 7; // objects on this layer feed the bloom buffer (trails, explosions)

// UI constants
export const FRAG_MESSAGE_TOP_OFFSET = 60; // Pixels from center for frag message
export const FRAG_MESSAGE_TEXT_SHADOW_X = 1; // Text shadow x offset
export const FRAG_MESSAGE_TEXT_SHADOW_Y = 1; // Text shadow y offset
export const FRAG_MESSAGE_TEXT_SHADOW_BLUR = 3; // Text shadow blur
export const FRAG_MESSAGE_LINE_HEIGHT = 1.5; // Line height multiplier

// Explosion physics constants
export const EXPLOSION_FALLOFF_MULTIPLIER_ROCKET = 2.5; // Rocket explosion falloff multiplier
export const EXPLOSION_FALLOFF_MULTIPLIER_DISC = 3.0; // Disc explosion falloff multiplier
export const EXPLOSION_COLLISION_MULTIPLIER = 2.0; // Collision detection multiplier
export const KNOCKBACK_MULTIPLIER = 0.4; // Knockback force multiplier
export const PULL_MULTIPLIER = 0.5; // Pull force multiplier

// Accuracy constants
export const ACCURACY_MAX = 10; // Maximum accuracy score
export const ACCURACY_NORMALIZATION = 8.0; // Accuracy normalization divisor

// Game loop constants
export const MAX_DELTA_TIME = 0.05; // Maximum delta time in seconds
export const REMOTE_PLAYER_FIXED_DT = 0.016; // Fixed delta time for remote player updates
export const GAME_LOOP_FIXED_DT = 1 / 15; // Fixed delta time for game loop (15Hz)
export const DEBUG_LOG_SAMPLE_RATE = 0.05; // 5% of updates log for debugging

// Player constants
export const MAX_HEALTH = 100; // Maximum player health
export const PLAYER_ID_LENGTH = 9; // Length of generated player ID
export const BUTTON_TIMEOUT = 10; // Button click timeout in milliseconds

// Remote player rendering: snapshot interpolation at a fixed delay
// (INTERP_DELAY lives on RemotePlayer — covers ~2 missed 20Hz packets)

// Effect constants
export const IMPLOSION_LIFE = 0.35; // Implosion effect lifetime
export const SHOCK_LIFE = 0.25; // Shockwave lifetime
export const FLASH_LIFE = 0.09; // Flash lifetime

// Terrain constants
export const TERRAIN_SIZE = 500.0; // Terrain size
export const TERRAIN_SUBDIV = 100; // Terrain subdivision
export const TERRAIN_HEIGHT_SCALE = 125.0; // Terrain height scale
export const TERRAIN_WORLD_SCALE = 1500.0; // Terrain world scale
export const TERRAIN_HEIGHTMAP_DIVISOR = 255.0; // Heightmap value divisor

// Networking backend configuration
// Options: 'tribes2' (Tribes2-style with bit-packing for LAN-like gameplay), 'fastapi' (Simple JSON-based WebSocket)
// Networking: single WebSocket transport — see networking/ + shared/wire.ts

// Tribes2 networking constants (per multiplayer specification)
export const WS_RECONNECT_INTERVAL = 3000; // WebSocket reconnection interval (ms)

