/** Env override for numeric/string scalars — keeps every tunable reachable
 *  from process env (docker -e, PM2, systemd) without code edits.
 *  This file is also compiled by the client tsconfig (P2P host reuse) —
 *  `process` isn't declared in browser-land, so declare + guard it. */
declare const process: { env: Record<string, string | undefined> } | undefined;
const ENV = typeof process === 'undefined' ? undefined : process.env;
function envNum(name: string, fallback: number): number {
  const v = ENV?.[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${name}=${v} is not a number — using ${fallback}`);
    return fallback;
  }
  return n;
}
function envStr(name: string, fallback: string): string {
  const v = ENV?.[name];
  return v === undefined || v === '' ? fallback : v;
}

export const CONFIG = {
  port: envNum('FPS_PORT', 8000),
  tickRate: envNum('FPS_TICK_HZ', 30),
  maxPlayers: envNum('FPS_MAX_PLAYERS', 32),
  // Whole-server cap across ALL rooms — rooms share one process/core, so
  // a per-room limit alone can't bound real load. 0 = unlimited.
  globalMaxPlayers: envNum('FPS_GLOBAL_MAX_PLAYERS', 128),

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

  // Movement authority flip: when set, the room's shadow sim OWNS player
  // truth — position reports become hints (yaw/ping/liveness) and the
  // sim's position is broadcast to everyone + echoed back as corrections.
  // Off = judge mode (report is truth, sim only flags divergence).
  moveAuthority: envStr('FPS_MOVE_AUTHORITY', '0') === '1',

  // Minimum projectile airtime (seconds) for a demo to be listed as a "cool shot".
  // Set to 0.2s during testing phase so clips are easy to trigger. Raise to ~2.0s for production.
  minDemoLifetime: envNum('FPS_MIN_DEMO_LIFETIME', 0.2),

  // Server-owned creature sim — binary heightmap (8-byte w/h header + raw R
  // channel) matching the client's test_vertex.png source.
  heightmapPath: envStr('FPS_HEIGHTMAP', ''),
  // Identity secret: session tokens are HMAC(playerId, secret). Set
  // FPS_SECRET to keep identities valid across restarts; unset = random
  // per boot (fine for dev, tokens die with the process).
  identitySecret: envStr('FPS_SECRET', ''),
  // Admin API bearer token for /admin/* (hot-reload, kick, end match).
  // Unset = admin endpoints disabled entirely — no accidental open admin.
  adminToken: envStr('FPS_ADMIN_TOKEN', ''),
  // Server-browser identity — what a master list / LAN browser shows.
  serverName: envStr('FPS_SERVER_NAME', 'kribes server'),
  // Free-text label (e.g. 'eu', 'lan', 'jp-lan') — clients just display it.
  serverRegion: envStr('FPS_SERVER_REGION', ''),
  // WebTransport tier (netcode v2): separate QUIC/HTTP3 UDP listener.
  // 0 = disabled. Cert/key are PEM file paths — WT has no plaintext mode;
  // certs/dev.{crt,key} are the built-in dev fallback. Default port 9443 so
  // a plain `bun src/server.ts` serves all three tiers.
  wtPort: envNum('FPS_WT_PORT', 9443),
  wtCertPath: envStr('FPS_WT_CERT', ''),
  wtKeyPath: envStr('FPS_WT_KEY', ''),
  // WebRTC tier: ICE servers (STUN/TURN) as JSON, e.g.
  // FPS_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com","username":"u","credential":"p"}]'
  // Empty = LAN/direct-connect only, which is what dev needs anyway.
  iceServersJson: envStr('FPS_ICE_SERVERS', ''),

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
    // teleport skips plausibility checks by design (declared warp), so the
    // only defense is rate: legit uses are respawn + blink, a few per minute
    teleport: { maxCount: 3, windowMs: 1000 },
    heal: { maxCount: 10, windowMs: 1000 }, // nugget pickups
    creatureHit: { maxCount: 120, windowMs: 1000 }, // chaingun-rate hit claims vs server creatures
    deploy: { maxCount: 4, windowMs: 1000 }, // plants are deliberate, not per-frame
    chat: { maxCount: 4, windowMs: 1000 }, // human typing speed, generous
    default: { maxCount: 120, windowMs: 1000 },
  } as const,

  playerIdPattern: /^[a-zA-Z0-9_-]+$/,
  playerIdMinLength: 1,
  playerIdMaxLength: 50,
} as const;
