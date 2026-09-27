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
  ping: number; // self-reported client RTT in ms
  skiing: number; // last reported ski input flag (0/1), from inputMove
  // Tick-send override: while Date.now() < forceSendUntil, this player is
  // included in every tick regardless of movement/distance suppression.
  // Set on hit/knockback — the victim's real trajectory MUST flow during
  // the shooter's ~0.6s predicted-knockback window, or remotes flap
  // between the predicted sim and the stale suppressed position.
  forceSendUntil: number;
}
