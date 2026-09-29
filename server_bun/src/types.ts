// Wire-facing message + entity types live in shared/protocol.ts — the
// single source of truth for both client and server. Re-exported here so
// existing `from './types.ts'` imports keep working.
export type {
  Vec3, Rotation,
  ClientMessage, ServerMessage,
  GameStatePlayer, SnapshotPlayer, LocalPlayerState,
  TickUpdatePlayer,
} from '../../shared/protocol.ts';

import type { Vec3, Rotation } from '../../shared/protocol.ts';

export interface WebSocketData {
  playerId: string;
  connectedAt: number;
  /** /rtc signalling sockets: relayed room-to-room, never reach GameServer. */
  rtc?: boolean;
  room?: string;
  /** /rtcs signalling sockets: negotiate a server-peer DataChannel. */
  rtcs?: boolean;
}

export interface PlayerState {
  id: string;
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
  lastSeen: number;
  pendingRespawn: boolean;
  lastSeq: number;
  lastValidPosition: Vec3;
  lastValidVelocity: Vec3;
  lastValidRotation: Rotation;
  hasReceivedPosition: boolean;
  // Anti-cheat position tracking — updated on EVERY position message (even
  // rejected ones) so speed checks always compare consecutive reports
  lastPosCheckTime: number;
  lastPosCheckPos: Vec3;
  consecutiveRejects: number; // escape hatch: client persisting past corrections gets force-resynced
  /** Plausibility check is muted until this time after a correction is
   *  sent — reports still in flight from the pre-snap trajectory would
   *  otherwise read as impossible speed. */
  correctionGraceUntil: number;
  ping: number; // self-reported client RTT in ms
  /** Netcode-v2 tier the join negotiated — surfaced to the scoreboard. */
  transport?: 'wt' | 'rtc' | 'ws';
  // Team-mode rooms (nuggets/ctf): assigned by the room at join — absent
  // in free-for-all modes. Owned by the server; clients never set it.
  team?: 'alpha' | 'bravo';
  /** Server-driven filler — no socket, no grace period, no idle reap. */
  isBot?: boolean;
  skiing: number; // last reported ski input flag (0/1), from inputMove
  // Status bitmask (shared/status.ts bits) from inputMove — the server
  // relays it to remotes and tests bits where mechanics care (shield soaks
  // damage, mend ticks health). Unknown bits pass through untouched, so
  // client-only effects need zero server changes.
  status: number;
  perk: string;      // join-declared passive (shared/perks.ts) — 'none' default
  armorClass: string; // join-declared armor tier (shared/botClasses.ts) — 'medium' default
  /** Mid-match classUpdate pick — applied on the next respawn, never
   *  mid-life (an instant tier swap would be a free heal). */
  pendingClass?: 'light' | 'medium' | 'heavy';
  /** Mid-match perkUpdate pick — same respawn-bank rule as pendingClass. */
  pendingPerk?: string;
  maxHealth: number; // derived from perk+class at join; heal/spawn caps use this
  // Lag-comp rewind buffer: accepted position reports stamped at server
  // receive time. Hit validation rewinds the target to the shooter's view
  // (now - shooterPing) so a 100ms player shoots the ghost they saw, not
  // the live position. Capped ~400ms / appended in handlePosition.
  history: { t: number; x: number; y: number; z: number }[];
  // Tick-send override: while Date.now() < forceSendUntil, this player is
  // included in every tick regardless of movement/distance suppression.
  // Set on hit/knockback — the victim's real trajectory MUST flow during
  // the shooter's ~0.6s predicted-knockback window, or remotes flap
  // between the predicted sim and the stale suppressed position.
  forceSendUntil: number;
  // Spawn protection: while Date.now() < protectedUntil, applyDamage
  // no-ops on this player. Set on join/respawn; firing clears it —
  // shooting from inside your own shield is the standard trade.
  protectedUntil: number;
  // Heal credit: team-mode rooms only accept heal claims backed by a
  // server-observed gem touch (+25 per gem). Without it the self-heal
  // claim (clamped 25/call) is a free-invincibility lever.
  healCredit: number;
  // Powerup state (creature drops): armor absorbs POWERUP.armorAbsorb of
  // incoming damage until depleted; regen/dd are expiry timestamps.
  armor: number;
  regenUntil: number;
  ddUntil: number;
}
