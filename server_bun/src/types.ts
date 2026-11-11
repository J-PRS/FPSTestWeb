// Wire-facing message + entity types live in shared/protocol.ts — the
// single source of truth for both client and server. Re-exported here so
// existing `from './types.ts'` imports keep working.
import type { Vec3, Rotation, TransportKind } from '../../shared/protocol.ts';
import type { TeamId } from '../../shared/teams.ts';
import type { SimMs } from './simClock.ts';
import type { WallMs } from './wallClock.ts';
import type { ArmorClass } from '../../shared/botClasses.ts';
import type { WirePosition } from '../../shared/wire.ts';
export type {
  Vec3, Rotation,
  ClientMessage, ServerMessage,
  GameStatePlayer, SnapshotPlayer, LocalPlayerState,
  TickUpdatePlayer,
} from '../../shared/protocol.ts';

export interface WebSocketData {
  playerId: string;
  connectedAt: number;
  /** /rtc signalling sockets: relayed room-to-room, never reach GameServer. */
  rtc?: boolean;
  room?: string;
  /** Host opted this room into the public lobby list (/rtc/lobbies). */
  open?: boolean;
  /** /rtcs signalling sockets: negotiate a server-peer DataChannel. */
  rtcs?: boolean;
  /** Seat generation stamped by SessionRegistry — a callback arriving on a
   *  socket whose gen isn't the session's current gen is stale and dies. */
  gen?: number;
  /** Wall time the send buffer first crossed the drown limit — cleared on
   *  drain, closed after the hysteresis. */
  slowSince?: number;
  /** Per-socket decode slot for binary position frames — decodePosition
   *  mutates it in place, consumers copy field-wise within the handler. */
  posScratch?: WirePosition;
  /** Text frames seen before the join handshake completes — unseated
   *  sockets get a hard frame/size budget (pre-join CPU flood). */
  preJoin?: number;
  /** Malformed/garbage frames seen; every rejection bumps it, past the
   *  cap the socket closes. A legit client emits zero, so the budget is
   *  pure headroom for a buggy one. */
  badFrames?: number;
  /** Effective client IP — behind the local reverse proxy every peer is
   *  127.0.0.1, so upgrade stamps the last X-Forwarded-For hop (the same
   *  rule serverRoutes uses for ops auth: XFF only when peer is loopback). */
  clientIp?: string;
  /** Join carried the ops admin key - the mint/ops override that survives
   *  the session for mid-match surfaces like switchRoom. */
  trusted?: boolean;
}

export interface PlayerState {
  id: string;
  /** Chosen display name from the join handshake — cosmetic only;
   *  identity, claims and claims-adjacent maps all still key on `id`. */
  name?: string;
  internalId: string;
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  health: number;
  isDead: boolean;
  kills: number;
  deaths: number;
  // Consecutive kills without dying — drives spree announcements. Wiped by
  // resetStats like kills/deaths (per-match, not career).
  streak: number;
  lastSeen: WallMs;
  /** Last position-claim receive — gameplay liveness only. Unlike
   *  lastSeen (pings/stats keep it fresh), an AFK hidden tab that sends
   *  only keepalives goes stale here — /rooms' `active` reads it. */
  lastClaimAt?: WallMs;
  pendingRespawn: boolean;
  lastSeq: number;
  lastValidPosition: Vec3;
  lastValidVelocity: Vec3;
  lastValidRotation: Rotation;
  hasReceivedPosition: boolean;
  joinAnnounced: boolean; // playerJoined broadcast fires once, at first report
  // Anti-cheat position tracking — updated on EVERY position message (even
  // rejected ones) so speed checks always compare consecutive reports
  lastPosCheckTime: WallMs;
  lastPosCheckPos: Vec3;
  consecutiveRejects: number; // escape hatch: client persisting past corrections gets force-resynced
  /** Plausibility check is muted until this time after a correction is
   *  sent — reports still in flight from the pre-snap trajectory would
   *  otherwise read as impossible speed. */
  correctionGraceUntil: WallMs;
  ping: number; // self-reported client RTT in ms
  /** Latest clientStats uplink — self-reported fps/jsMs + link quality.
   *  Stamped at receive so /metrics can drop stale reporters. */
  clientStats?: { fps: number; jsMs: number; ping: number; loss: number; jitter: number; renderLagMs?: number; renderLag?: Record<string, number>; gap?: number; starve?: number; starveMs?: number; drainMsMax?: number; at: WallMs };
  /** Netcode-v2 tier the join negotiated — surfaced to the scoreboard. */
  transport?: TransportKind;
  /** Clock-drift probe window (ping handler): s0/a0 anchor the window in
   *  client-stamp/server-arrival space, s/a the latest sample. A client
   *  running its whole runtime fast stamps pings ~rate× quicker than they
   *  can arrive — declared/arrival spacing diverges at ~1.2x for a
   *  speedhack, ~1.0 honest (per-ping jitter averages out over ~20s). */
  clockProbe?: { s0: number; a0: number; s: number; a: number; strikes: number };
  // Team-mode rooms (nuggets/ctf): assigned by the room at join — absent
  // in free-for-all modes. Owned by the server; clients never set it.
  team?: TeamId;
  /** Server-driven filler — no socket, no grace period, no idle reap. */
  isBot?: boolean;
  skiing: number; // last reported ski input flag (0/1), from inputMove
  jetting: number; // last reported jet input flag (0/1) — broadcast so remote DR burns thrust
  // Status bitmask (shared/status.ts bits) from inputMove — the server
  // relays it to remotes and tests bits where mechanics care (shield soaks
  // damage, mend ticks health). Unknown bits pass through untouched, so
  // client-only effects need zero server changes.
  status: number;
  /** Sim-clock stamp of the player's last real shot — senses mask CLOAK
   *  for SHOOT_REVEAL_S after it (firing decloaks). -Infinity until the
   *  first shot; reset on respawn like the status bits it feeds. */
  lastFireSim: SimMs;
  perk: string;      // join-declared passive (shared/perks.ts) — 'none' default
  armorClass: string; // join-declared armor tier (shared/botClasses.ts) — 'medium' default
  /** Current weapon the server knows — set at loadout assignment (bots)
   *  and every authoritative shell spawn. Rides the roster so remotes
   *  draw a real gun, not the placeholder prop, before a shot edge. */
  weapon?: number;
  /** Gun-game ladder position (shared/gunGame.ts) - gungame rooms only.
   *  Player state like `weapon`: survives grace-period reclaim because
   *  the seat's PlayerState does; resets on match restart. */
  gunRung?: number;
  /** Join-declared Q skill — skillUse claims naming another skill are
   *  refused; undeclared (old clients) skips the identity check. */
  skill?: string;
  /** Wall ms of the last accepted skillUse — per-skill cooldown is
   *  client law, but the server's 850ms floor stops a free-firing claim. */
  lastSkillUse?: number;
  /** Mid-match classUpdate pick — applied on the next respawn, never
   *  mid-life (an instant tier swap would be a free heal). */
  pendingClass?: ArmorClass;
  /** Mid-match perkUpdate pick — same respawn-bank rule as pendingClass. */
  pendingPerk?: string;
  maxHealth: number; // derived from perk+class at join; heal/spawn caps use this
  // Lag-comp rewind buffer: accepted position reports stamped at server
  // receive time. Hit validation rewinds the target to the shooter's view
  // (now - shooterPing) so a 100ms player shoots the ghost they saw, not
  // the live position. Capped ~400ms / appended in handlePosition.
  history: { t: WallMs; x: number; y: number; z: number; vx: number; vy: number; vz: number }[];
  // Tick-send override: while wallNow() < forceSendUntil, this player is
  // included in every tick regardless of movement/distance suppression.
  // Set on hit/knockback — the victim's real trajectory MUST flow during
  // the shooter's ~0.6s predicted-knockback window, or remotes flap
  // between the predicted sim and the stale suppressed position.
  forceSendUntil: WallMs;
  // Spawn protection: while wallNow() < protectedUntil, applyDamage
  // no-ops on this player. Set on join/respawn; firing clears it —
  // shooting from inside your own shield is the standard trade.
  protectedUntil: SimMs;
  /** Seat held off-spawn: the client is still behind its session veil,
   *  warming — the body must not exist until it says 'ready'. While set,
   *  isDead is forced true (every damage/collision funnel already skips
   *  the dead), records/announce/roster suppress on the flag itself.
   *  `dead`/`hp` snapshot the real state for release; `at` bounds the
   *  hold — a client that never sends ready auto-releases. */
  awaitingReady?: { at: WallMs; dead: boolean; hp: number };
  /** Join-declared spawn hold — reclaim re-arms the hold only for seats
   *  that asked at join (browser veil clients; bots/probes never set it). */
  spawnHold?: boolean;
  // Heal credit: team-mode rooms only accept heal claims backed by a
  // server-observed gem touch (+25 per gem). Without it the self-heal
  // claim (clamped 25/call) is a free-invincibility lever.
  healCredit: number;
  // Belt/pack charges: BELT_MAX on spawn, −1 per belt toss, −2 per pack
  // deploy, +1 per nugget (gem/tag) touch — one pool, shared/weapons.ts.
  beltCharges: number;
  /** Per-weapon pool rounds (ammoCap rows - PlasmaGun pilot). Lazy
   *  accrual on this player's own fire clock; cleared on respawn =
   *  refilled (absent cell reads full). shared/weapons.ts AmmoPool. */
  ammoPool: Map<number, { ammo: number; t: number; shotAt: number }>;
  // Headhunt held tokens — the mode's live score, dropped wholesale on
  // death. Distinct from beltCharges: tokens are score, charges are ammo.
  heldTokens: number;
  /** Fractional belt-charge drip from HELD_BUFF — accumulates until a
   *  whole charge lands. */
  beltAcc: number;
  // Powerup state (creature drops): armor absorbs POWERUP.armorAbsorb of
  // incoming damage until depleted; regen/dd are expiry timestamps.
  armor: number;
  regenUntil: SimMs;
  ddUntil: SimMs;
  shieldUntil: SimMs;
  /** EMP disable: while simNow() < empUntil, jet is disabled and shield
   *  is stripped (server ignores the SHIELD bit in inputMove). Drained
   *  energy regens at the normal rate; the disable is the duration. */
  empUntil: SimMs;
  /** Last time this player took a hit (sim clock) — the regenerator
   *  perk's ramp counts unhurt seconds from here and resets on damage. */
  lastDamageAt: SimMs;
  // LG pop-charge banked ON this victim by enemy beams — the walking bomb.
  // `charge` is the bank at `chargeT` (epoch s); reads decay lazily via
  // lgChargeAt (5× drain), so no ticking needed. Any non-LG hit detonates
  // min(bank, hitDamage); death pops the rest.
  charge: number;
  chargeT: number;
  // yourCharge echo bookkeeping — last sent value + throttle (ms).
  chargeEchoed: number;
  chargeEchoAt: WallMs;
  /** Last time the owner was echoed their server-healed hp (yourHealth
   *  throttle — healPerTick runs every tick, one echo per 500ms is enough
   *  to keep the client's HUD and state-hash view converged). */
  healthEchoAt: WallMs;
  /** yourAmmo echo throttle - same 500ms cadence as healthEchoAt. */
  ammoEchoAt: WallMs;
  /** Bloom cone state (chaingun): accumulated radius in dir-offset
   *  units + the last-shot stamp the lazy decay measures from. The
   *  server owns the cone - it jitters the claimed dir by this. */
  bloom: number;
  bloomAt: number;
  /** Per-shooter cone draw counter - the seed is server-side, so a
   *  client can't brute-force favorable shotIds (CSGO random_seed class). */
  bloomSeq: number;
}

/** Uniform claim verdict — `true` = applied/accepted, a string = the
 *  server's drop reason (echoed to the claimant inside claimAck). */
export type ClaimVerdict = true | string;

/** Creature-hit claim verdict — `killed` feeds kill-edge telemetry,
 *  `reason` names the drop when the claim never touched the sim. */
export interface HitVerdict { killed: boolean; reason?: string }
