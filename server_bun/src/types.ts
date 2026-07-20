export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Rotation {
  yaw: number;
  pitch: number;
}

export interface WebSocketData {
  playerId: string;
  connectedAt: number;
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
}

export type ClientMessage =
  | { type: 'position'; position: Vec3; rotation: Rotation; velocity: Vec3; seq?: number }
  | { type: 'ping'; timestamp: number }
  | { type: 'shot'; targetId: string | null; position?: Vec3; velocity?: Vec3; timestamp?: number; projectileId?: string | null }
  | { type: 'aoeShot'; position: Vec3; excludeTargetId?: string | null }
  | { type: 'discAOEShot'; position: Vec3; excludeTargetId?: string | null }
  | { type: 'grenadeAOEShot'; position: Vec3; excludeTargetId?: string | null }
  | { type: 'jump'; position: Vec3 }
  | { type: 'jetpack'; position: Vec3 }
  | { type: 'inputMove'; input: { forward: number; right: number; jump: number; ski: number }; rotation: Rotation }
  | { type: 'projectileDestroy'; projectileId: string }
  | { type: 'input'; input: unknown }
  | { type: 'snapshotRequest' };

export type ServerMessage =
  | { type: 'gameState'; players: GameStatePlayer[]; localPlayerState?: LocalPlayerState }
  | { type: 'playerJoined'; playerId: string; internalId: string; position: Vec3; rotation: Rotation }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'playerHit'; shooterId: string; targetId: string; damage: number; health: number }
  | { type: 'playerKill'; shooterId: string; targetId: string }
  | { type: 'knockback'; targetId: string; position: Vec3; force: number; pull?: boolean }
  | { type: 'playerRespawn'; playerId: string; internalId: string; position: Vec3; rotation: Rotation }
  | { type: 'jump'; playerId: string; position: Vec3 }
  | { type: 'jetpack'; playerId: string; position: Vec3 }
  | { type: 'projectileCreated'; projectileId: string; ownerId: string; position: Vec3; velocity: Vec3 }
  | { type: 'projectileDestroyed'; projectileId: string }
  | { type: 'snapshot'; players: SnapshotPlayer[]; timestamp: number }
  | { type: 'stateHash'; hash: string; tick: number; playerCount: number; timestamp: number }
  | { type: 'tickUpdate'; updates: Array<{ playerId: string; internalId: string; position: Vec3; rotation: Rotation; velocity: Vec3; health: number; isDead: boolean }>; ackSeq?: number }
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
