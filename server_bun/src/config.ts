export const CONFIG = {
  port: 8000,
  tickRate: 30,
  maxPlayers: 32,

  playerMaxHealth: 100,
  respawnDelayMs: 3000,
  shotDamage: 50,
  aoeDamage: 15,
  aoeRadius: 6.0,
  knockbackForce: 28.0,
  discAoeDamage: 10,
  discAoeRadius: 5.0,
  discPullForce: 25.0,
  grenadeAoeDamage: 20,
  grenadeAoeRadius: 10.0,
  grenadeKnockbackForce: 45.0,

  spawnPoints: [
    { x: 0, y: 60, z: 0 },
    { x: 50, y: 60, z: 0 },
    { x: -50, y: 60, z: 0 },
    { x: 0, y: 60, z: 50 },
    { x: 0, y: 60, z: -50 },
    { x: 80, y: 60, z: 80 },
    { x: -80, y: 60, z: -80 },
    { x: 80, y: 60, z: -80 },
  ] as const,

  idleTimeoutSec: 120,
  maxPayloadLength: 1024 * 1024,
  hashBroadcastIntervalMs: 2000,

  // Minimum projectile airtime (seconds) for a demo to be listed as a "cool shot".
  // Set to 0.2s during testing phase so clips are easy to trigger. Raise to ~2.0s for production.
  minDemoLifetime: 0.2,

  rateLimits: {
    position: { maxCount: 25, windowMs: 1000 },
    shot: { maxCount: 10, windowMs: 1000 },
    aoeShot: { maxCount: 10, windowMs: 1000 },
    discAOEShot: { maxCount: 10, windowMs: 1000 },
    jump: { maxCount: 10, windowMs: 1000 },
    jetpack: { maxCount: 60, windowMs: 1000 },
    inputMove: { maxCount: 120, windowMs: 1000 },
    input: { maxCount: 120, windowMs: 1000 },
    default: { maxCount: 120, windowMs: 1000 },
  } as const,

  playerIdPattern: /^[a-zA-Z0-9_-]+$/,
  playerIdMinLength: 1,
  playerIdMaxLength: 50,
} as const;
