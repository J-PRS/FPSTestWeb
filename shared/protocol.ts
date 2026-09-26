/**
 * Shared protocol — every message that crosses the wire, defined once.
 * Server imports these directly; client imports for typed handlers.
 *
 * Hot-path messages (position up, tickUpdate down) travel as binary frames
 * encoded by wire.ts — these types document the DECODED shapes, which the
 * codec produces/consumes.
 *
 * Bump PROTOCOL_VERSION whenever the wire format changes in a way that a
 * stale client can't safely ignore (new binary frame layout, removed
 * message, changed field semantics). The server stamps it on gameState;
 * the client force-reloads on mismatch instead of silently desyncing.
 */
export const PROTOCOL_VERSION = 2;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Rotation {
  yaw: number;
  pitch: number;
}

export type ClientMessage =
  | { type: 'join'; playerId: string; token?: string }
  | { type: 'position'; position: Vec3; rotation: Rotation; velocity: Vec3; seq?: number; ping?: number }
  | { type: 'ping'; timestamp: number }
  | { type: 'shot'; targetId: string | null; weaponType?: number; position?: Vec3; velocity?: Vec3; timestamp?: number; projectileId?: string | null; airtime?: number }
  | { type: 'aoeShot'; position: Vec3; weaponType?: number; excludeTargetId?: string | null }
  | { type: 'jump'; position: Vec3 }
  | { type: 'jetpack'; position: Vec3 }
  | { type: 'inputMove'; input: { forward: number; right: number; jump: number; ski: number }; rotation: Rotation }
  | { type: 'projectileDestroy'; projectileId: string }
  | { type: 'environmentDamage'; amount: number }
  | { type: 'snapshotRequest' };

export interface TickUpdatePlayer {
  playerId: string;
  internalId?: string; // not on the binary wire — roster field from gameState/playerJoined
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  health: number;
  isDead: boolean;
  ping?: number;
  ski?: number;
}

export type ServerMessage =
  | { type: 'gameState'; players: GameStatePlayer[]; localPlayerState?: LocalPlayerState; sessionToken?: string; protocolVersion?: number }
  | { type: 'playerJoined'; playerId: string; internalId: string; position: Vec3; rotation: Rotation }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'playerHit'; shooterId: string; targetId: string; damage: number; health: number }
  | { type: 'playerKill'; shooterId: string; targetId: string }
  | { type: 'knockback'; targetId: string; position: Vec3; force: number; pull?: boolean }
  | { type: 'playerRespawn'; playerId: string; internalId: string; position: Vec3; rotation: Rotation }
  | { type: 'jump'; playerId: string; position: Vec3 }
  | { type: 'jetpack'; playerId: string; position: Vec3 }
  | { type: 'projectileCreated'; projectileId: string; ownerId: string; position: Vec3; velocity: Vec3; weaponType?: number }
  | { type: 'projectileDestroyed'; projectileId: string }
  | { type: 'snapshot'; players: SnapshotPlayer[]; timestamp: number }
  | { type: 'stateHash'; hash: string; tick: number; playerCount: number; timestamp: number }
  | { type: 'tickUpdate'; updates: TickUpdatePlayer[]; ackSeq?: number }
  | { type: 'correction'; seq: number; position: Vec3; velocity: Vec3; rotation: Rotation }
  | { type: 'pong'; timestamp: number };

export interface GameStatePlayer {
  id: string;
  internalId: string;
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  isDead: boolean;
  health: number;
}

export interface SnapshotPlayer {
  id: string;
  internalId: string;
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  health: number;
  isDead: boolean;
  kills: number;
  deaths: number;
}

export interface LocalPlayerState {
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  health: number;
  isDead: boolean;
}
