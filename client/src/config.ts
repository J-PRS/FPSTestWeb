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

// Player physics constants
export const PLAYER_RADIUS = 0.8; // Player collision radius
export const PLAYER_HEIGHT = 2.0; // Player height

// Player jetpack constants
export const JET_FORCE_UP = 35.0; // Vertical jetpack force
export const JET_FORCE_DIR = 10.0; // Lateral jetpack control
export const MAX_ENERGY = 60.0; // Maximum jetpack energy
export const JET_DRAIN = 12.0; // Energy drain per second
export const JET_CHARGE = 8.0; // Energy recharge per second

// Weapon constants
export const FIRE_RATE = 0.8; // Rocket fire rate (seconds)
export const DISC_RATE = 1.0; // Disc fire rate (seconds)

// Projectile constants
export const ROCKET_SPEED = 120.0; // Rocket velocity
export const ROCKET_RADIUS = 6.0; // Rocket explosion radius
export const ROCKET_FORCE = 28.0; // Rocket knockback force
export const HIT_MIN = 0.3; // Minimum hitbox radius (core for direct hits)
export const HIT_MAX = 8.0; // Maximum hitbox radius
export const HIT_GROW = 2.0; // Seconds to reach full hitbox size

// Disc constants
export const DISC_SPEED = 80.0; // Disc velocity
export const DISC_RADIUS = 5.0; // Disc explosion radius
export const DISC_FORCE = 25.0; // Disc pull force
export const DISC_HITBOX = 0.5; // Disc hitbox size

// Game constants
export const BALL_SPAWN_INTERVAL = 2.5; // Seconds between ball spawns

// Ball constants
export const BALL_MAX_DIST = 300.0; // Maximum distance before teleport
export const BALL_TELE_MIN = 60.0; // Minimum teleport distance
export const BALL_TELE_MAX = 120.0; // Maximum teleport distance
export const BALL_TELE_HEIGHT = 25.0; // Teleport height
export const BALL_MAX = 20; // Maximum number of balls in play

// Renderer constants
export const PIXEL_SCALE = 4; // Each pixel is 4x4 screen pixels (Doom-style)
export const RENDERER_PIXEL_RATIO = 1; // Device pixel ratio

// Camera constants
export const CAMERA_FOV = 90; // Field of view in degrees
export const CAMERA_NEAR = 0.1; // Near clipping plane
export const CAMERA_FAR = 6000; // Far clipping plane

// Fog constants
export const FOG_COLOR = 0x7aaadd; // Fog and clear color (slightly less blue)
export const FOG_DENSITY = 0.006; // Exponential fog density

// Atmospheric sky constants
export const SKY_TURBIDITY = 10.0;
export const SKY_RAYLEIGH = 1.5; // Reduced to reduce bright spot
export const SKY_MIE_COEFFICIENT = 0.0; // Disabled to remove white glare
export const SKY_MIE_DIRECTIONAL_G = 0.7;
export const SKY_SUN_INTENSITY = 1.0; // Minimal to remove white circle

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
export const SHADOW_CAMERA_SIZE = 600; // Shadow camera frustum size
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
export const TONE_MAPPING_EXPOSURE = 1.0; // Tone mapping exposure

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

// Remote player interpolation constants
export const REMOTE_PLAYER_BASE_LERP_FACTOR = 10.0; // Base interpolation factor
export const REMOTE_PLAYER_MAX_LERP_FACTOR = 20.0; // Maximum interpolation factor
export const REMOTE_PLAYER_DISTANCE_MULTIPLIER = 0.5; // Distance multiplier for adaptive interpolation
export const REMOTE_PLAYER_ROTATION_MULTIPLIER = 1.5; // Rotation interpolation multiplier
export const REMOTE_PLAYER_PING_MULTIPLIER = 0.02; // Ping multiplier for interpolation adjustment
export const REMOTE_PLAYER_MAX_PING_BONUS = 10.0; // Maximum bonus from high ping

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
export const NETWORK_BACKEND = 'fastapi' as const;

// Tribes2 networking constants (per multiplayer specification)
export const TRIBES2_MAX_PACKET_SIZE = 1400; // MTU-safe packet size
export const TRIBES2_PACKETS_PER_SECOND = 30; // Packets per second (tick rate)
export const TRIBES2_MAX_BYTES_PER_SECOND = 42000; // Bandwidth limit per player
export const TRIBES2_RECONNECT_INTERVAL = 3000; // WebSocket reconnection interval (ms)

