/** Env override for numeric/string scalars — keeps every tunable reachable
 *  from process env (docker -e, PM2, systemd) without code edits. */
function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${name}=${v} is not a number — using ${fallback}`);
    return fallback;
  }
  return n;
}
function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const CONFIG = {
  port: envNum('FPS_PORT', 8000),
  tickRate: envNum('FPS_TICK_HZ', 30),
  maxPlayers: envNum('FPS_MAX_PLAYERS', 32),

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

  idleTimeoutSec: envNum('FPS_IDLE_TIMEOUT_S', 120),
  maxPayloadLength: envNum('FPS_MAX_PAYLOAD', 1024 * 1024),
  hashBroadcastIntervalMs: envNum('FPS_HASH_INTERVAL_MS', 2000),
  reconnectGraceMs: envNum('FPS_RECONNECT_GRACE_MS', 10000),
  idleKickMs: envNum('FPS_IDLE_KICK_MS', 60_000),

  // Minimum projectile airtime (seconds) for a demo to be listed as a "cool shot".
  // Set to 0.2s during testing phase so clips are easy to trigger. Raise to ~2.0s for production.
  minDemoLifetime: envNum('FPS_MIN_DEMO_LIFETIME', 0.2),

  // Server-owned creature sim — binary heightmap (8-byte w/h header + raw R
  // channel) matching the client's test_vertex.png source.
  heightmapPath: envStr('FPS_HEIGHTMAP', ''),

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
