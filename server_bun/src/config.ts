/** Env override for numeric/string scalars — keeps every tunable reachable
 *  from process env (docker -e, PM2, systemd) without code edits.
 *  This file is also compiled by the client tsconfig (P2P host reuse) —
 *  `process` isn't declared in browser-land, so declare + guard it. */
import { setSharedEnv, setSharedNow } from '../../shared/env.ts';
import { wallNow } from './wallClock.ts';
declare const process: { env: Record<string, string | undefined> } | undefined;
const ENV = typeof process === 'undefined' ? undefined : process.env;
function envNum(name: string, fallback: number): number {
  const v = ENV?.[name];
  if (v === undefined || v === '') {return fallback;}
  const n = Number(v);
  if (!Number.isFinite(n)) {
    // oxlint-disable-next-line no-console
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
  // Balls and creatures are offline/coop content. Off by default so the
  // PvP server never spawns them; set FPS_ALLOW_BALLS=1 / FPS_ALLOW_CREATURES=1
  // to allow clients to request them again.
  allowBalls: envNum('FPS_ALLOW_BALLS', 0) === 1,
  allowCreatures: envNum('FPS_ALLOW_CREATURES', 0) === 1,
  // Server loop cadence — drives the broadcast interval AND per-tick
  // heal divisors. Default 20Hz matches the hardcoded historical loop.
  tickRate: envNum('FPS_TICK_HZ', 20),
  maxPlayers: envNum('FPS_MAX_PLAYERS', 32),
  // Whole-server cap across ALL rooms — rooms share one process/core, so
  // a per-room limit alone can't bound real load. 0 = unlimited.
  globalMaxPlayers: envNum('FPS_GLOBAL_MAX_PLAYERS', 128),
  /** Live-room cap — joins may name any room, so without this a script
   *  mints a heavyweight Room per fresh name forever. Past the cap the
   *  eldest audience-less room is recycled; a full roster of LIVE rooms
   *  rejects new mints outright. */
  maxRooms: envNum('FPS_MAX_ROOMS', 256),
  /** A socket that connects but never completes the join handshake would
   *  otherwise sit forever (QUIC/RTC peers don't die quickly). */
  joinTimeoutMs: envNum('FPS_JOIN_TIMEOUT_MS', 15_000),

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

  // In-flight-report drain window (~1 RTT plus margin): any event that
  // reseats a client's position source-of-truth (correction, respawn,
  // room hop) must mute position judging this long or honest stragglers
  // from the old trajectory read as impossible speed/divergence.
  reportGraceMs: 500,

  // uWS's per-socket idle timer re-arms on every frame (~12K native
  // re-arms/s at load) — our app-level reap (idleKickMs=60s, closes the
  // ws itself) is stricter anyway, so the native timer is pure overhead.
  idleTimeoutSec: envNum('FPS_IDLE_TIMEOUT_S', 0),
  maxPayloadLength: envNum('FPS_MAX_PAYLOAD', 1024 * 1024),
  hashBroadcastIntervalMs: envNum('FPS_HASH_INTERVAL_MS', 2000),
  // Reclaim window must exceed the full reconnect chain — close detect
  // (up to the 4s stall watchdog) + tier reprobe (WT→RTC→WS, ~3s each +
  // timeouts) + join roundtrip can pass 15s on a flap. A drop that lands
  // after expiry joins fresh and the player respawns, so this needs real
  // headroom, not just "F5 is fast" margin.
  reconnectGraceMs: envNum('FPS_RECONNECT_GRACE_MS', 60_000),
  idleKickMs: envNum('FPS_IDLE_KICK_MS', 60_000),

  // Movement authority flip: when set, the room's shadow sim OWNS player
  // truth — position reports become hints (yaw/ping/liveness) and the
  // sim's position is broadcast to everyone + echoed back as corrections.
  // Off = judge mode (report is truth, sim only flags divergence).
  moveAuthority: envStr('FPS_MOVE_AUTHORITY', '0') === '1',

  // Friendly fire: default OFF — teammates can't damage each other in
  // team rooms. FPS_FRIENDLY_FIRE=1 lets team damage through the friendly
  // gate (splash knockback onto teammates stays on either way).
  friendlyFire: envStr('FPS_FRIENDLY_FIRE', '0') === '1',

  // Minimum projectile airtime (seconds) for a demo to be listed as a "cool shot".
  // Set to 0.2s during testing phase so clips are easy to trigger. Raise to ~2.0s for production.
  minDemoLifetime: envNum('FPS_MIN_DEMO_LIFETIME', 0.2),

  // Live clip-index cap — evictions gzip into demos/archive/, which is
  // write-only (operator-managed, never auto-deleted).
  demoMaxClips: envNum('FPS_DEMO_MAX', 100),
  // Where the static client lives — /clips deep-link shells refresh there.
  // Empty = co-hosted (the game server serves the client too).
  clientUrl: envStr('FPS_CLIENT_URL', ''),

  // Server-owned creature sim — binary heightmap (8-byte w/h header + raw R
  // channel) matching the client's test_vertex.png source.
  heightmapPath: envStr('FPS_HEIGHTMAP', ''),
  // Identity secret: session tokens are HMAC(playerId, secret). Set
  // FPS_SECRET to keep identities valid across restarts; unset = random
  // per boot (fine for dev, tokens die with the process).
  identitySecret: envStr('FPS_SECRET', ''),
  // Admin API bearer token for /admin/* (hot-reload, kick, end match).
  // Unset = admin endpoints disabled entirely — no accidental open admin.
  // Also gates the ops surfaces (/metrics, /status, /weaponstats*): when
  // set they need `?key=<token>` or the bearer header; unset = open (dev).
  adminToken: envStr('FPS_ADMIN_TOKEN', ''),
  // CORS allow-origin: a public deploy should answer its own origin(s),
  // comma-separated — '*' is for dev where the vite server lives on :5400.
  corsOrigin: envStr('FPS_CORS_ORIGIN', '*'),
  // Server-browser identity — what a master list / LAN browser shows.
  serverName: envStr('FPS_SERVER_NAME', 'kribes server'),
  // Free-text label (e.g. 'eu', 'lan', 'jp-lan') — clients just display it.
  serverRegion: envStr('FPS_SERVER_REGION', ''),
  // WebTransport tier (netcode v2): separate QUIC/HTTP3 UDP listener.
  // 0 = disabled. Cert/key are PEM file paths — WT has no plaintext mode;
  // certs/dev.{crt,key} are the built-in dev fallback. The default tracks
  // FPS_PORT (+1443, so port 8000 → 9443 unchanged) — a second instance on
  // an alternate FPS_PORT must not collide on a fixed UDP port (seen: dev
  // server + test server both binding 9443 → EADDRINUSE at startup).
  wtPort: envNum('FPS_WT_PORT', envNum('FPS_PORT', 8000) + 1443),
  // Port clients dial for WT. Differs from wtPort when a firewall forwards
  // a public UDP port to the listener (443 → 9443 behind an HTTPS origin).
  wtAdvertisePort: envNum('FPS_WT_ADVERTISE_PORT', envNum('FPS_WT_PORT', envNum('FPS_PORT', 8000) + 1443)),
  wtCertPath: envStr('FPS_WT_CERT', ''),
  wtKeyPath: envStr('FPS_WT_KEY', ''),
  // Direct wss listener: a second Bun.serve on the same handlers with
  // TLS inside uWS - the measured ~0.9-core win on the A1 (Caddy stays
  // for matchmaker/metrics only). Enabled when cert+key paths are set;
  // the default port derives from FPS_PORT (8001→8443, 8002→8444, …) so
  // fleet workers land on distinct ports without per-worker env. Each
  // exposed worker needs NSG ingress on its port.
  tlsPort: envNum('FPS_TLS_PORT', envNum('FPS_PORT', 8000) + 442),
  tlsCertPath: envStr('FPS_TLS_CERT', ''),
  tlsKeyPath: envStr('FPS_TLS_KEY', ''),
  // WebRTC tier: ICE servers (STUN/TURN) as JSON, e.g.
  // FPS_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com","username":"u","credential":"p"}]'
  // Empty = LAN/direct-connect only, which is what dev needs anyway.
  iceServersJson: envStr('FPS_ICE_SERVERS', ''),

  // Public-beta asset profile: drop the rights-restricted content —
  // _t2-marked map specs vanish from the catalog and maps/t2/* fetches
  // 404. Off in dev where the full T2 port set stays playable.
  publicBeta: envStr('FPS_PUBLIC_BETA', '0') === '1',

  // Room minting is an admin privilege in public deploys: untrusted
  // joins may only seat existing rooms (FPS_CLIENT_ROOMS=0 on the fleet).
  // A join carries no privileged params itself - 'trusted' (adminKey)
  // is the per-connection override for ops drivers.
  get clientRooms(): boolean { return envStr('FPS_CLIENT_ROOMS', '1') === '1'; },

  // Per-type rate limits live in wire.ts beside the validators and
  // handlers — one WIRE entry is the whole contract for a message type.

  playerIdPattern: /^[a-zA-Z0-9_-]+$/,
  playerIdMinLength: 1,
  playerIdMaxLength: 50,
} as const;

// Seed the shared/ env seam once — shared modules read sharedEnv/sharedNow,
// never process.env or Date.now directly (the client compiles this file
// too; in a browser these stay the pure defaults or bind Date.now fine).
setSharedEnv({ traceId: ENV?.FPS_TRACE, noMuzzle: ENV?.FPS_NOMUZZLE !== undefined, botGoalsDebug: ENV?.BOTGOALS_DEBUG !== undefined });
setSharedNow(wallNow);
