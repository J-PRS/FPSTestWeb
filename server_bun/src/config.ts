export const CONFIG = {
  port: 8000,
  tickRate: 30,
  maxPlayers: 32,

  playerMaxHealth: 100,
  respawnDelayMs: 3000,
  // Weapon damage/radius/knockback live in shared/weapons.ts — single
  // source of truth for client + server. Don't re-add stats here.

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
    position: { maxCount: 30, windowMs: 1000 },
    shot: { maxCount: 20, windowMs: 1000 }, // chaingun fires ~11/s spawn events
    aoeShot: { maxCount: 15, windowMs: 1000 }, // all AOE weapons share one bucket — GL spam is the ceiling
    jump: { maxCount: 10, windowMs: 1000 },
    jetpack: { maxCount: 60, windowMs: 1000 },
    inputMove: { maxCount: 120, windowMs: 1000 },
    input: { maxCount: 120, windowMs: 1000 },
    projectileDestroy: { maxCount: 30, windowMs: 1000 },
    environmentDamage: { maxCount: 10, windowMs: 1000 }, // crawler pounces etc.
    heal: { maxCount: 10, windowMs: 1000 }, // nugget pickups
    creatureHit: { maxCount: 120, windowMs: 1000 }, // chaingun-rate hit claims vs server creatures
    default: { maxCount: 120, windowMs: 1000 },
  } as const,

  playerIdPattern: /^[a-zA-Z0-9_-]+$/,
  playerIdMinLength: 1,
  playerIdMaxLength: 50,
} as const;
