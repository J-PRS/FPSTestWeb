/**
 * TypeScript interfaces for network message types
 * Provides type safety for binary protocol encoding/decoding
 */

// Base position/rotation types
export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface Rotation {
  yaw: number;
  pitch: number;
}

export interface Velocity {
  x: number;
  y: number;
  z: number;
}

// Message types
export interface JoinMessage {
  type: 'join';
  playerId: string;
}

export interface InputMessage {
  type: 'input';
  playerId: string;
  sequenceNumber: number;
  timestamp: number;
  input: {
    forward: number; // -127 to 127
    right: number; // -127 to 127
    jump: number; // 0 or 1
    ski: number; // 0 or 1
  };
}

export interface PositionMessage {
  type: 'position';
  playerId: string;
  data: {
    position: Position;
    rotation: Rotation;
    timestamp: number;
  };
}

export interface PositionDeltaMessage {
  type: 'positionDelta';
  playerId: string;
  data: {
    positionDelta: Position;
    rotationDelta: Rotation;
    timestamp: number;
  };
}

export interface ShotMessage {
  type: 'shot';
  playerId: string;
  data: {
    targetId: string | null;
    timestamp: number;
    position?: Position;
    velocity?: Velocity;
    projectileId?: string | null;
    directHit?: boolean;
  };
}

export interface StateReconciliationMessage {
  type: 'stateReconciliation';
  playerId: string;
  data: {
    lastProcessedSequence: number;
    position: Position;
    rotation: Rotation;
    velocity: Velocity;
  };
}

export interface HitConfirmationMessage {
  type: 'hitConfirmation';
  data: {
    shooterId: string;
    targetId: string;
    confirmed: boolean;
    damage: number;
    timestamp: number;
  };
}

// JSON message types (non-binary)
export interface JSONMessage {
  type: string;
  [key: string]: any;
}

export interface PlayerJoinedMessage extends JSONMessage {
  type: 'playerJoined';
  playerId: string;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
}

export interface PlayerLeftMessage extends JSONMessage {
  type: 'playerLeft';
  playerId: string;
}

export interface PlayerUpdateMessage extends JSONMessage {
  type: 'playerUpdate';
  playerId: string;
  position: Position;
  rotation: Rotation;
  sequenceNumber?: number;
  velocity?: Velocity;
  timestamp?: number;
}

export interface GameStateMessage extends JSONMessage {
  type: 'gameState';
  players: Array<{
    playerId: string;
    position: Position;
    rotation: Rotation;
    velocity?: Velocity;
    health: number;
    isDead: boolean;
  }>;
  localPlayerState?: {
    position: Position;
    rotation: Rotation;
    velocity?: Velocity;
    health: number;
    isDead: boolean;
    lastProcessedSequence?: number;
  };
}

export interface HitMessage extends JSONMessage {
  type: 'hit';
  shooterId: string;
  targetId: string;
  damage: number;
}

export interface KillMessage extends JSONMessage {
  type: 'kill';
  shooterId: string;
  targetId: string;
}

export interface PlayerRespawnMessage extends JSONMessage {
  type: 'playerRespawn';
  playerId: string;
  position: Position;
  rotation: Rotation;
}

export interface JumpMessage extends JSONMessage {
  type: 'jump';
  playerId: string;
  position: Position;
}

export interface JetpackMessage extends JSONMessage {
  type: 'jetpack';
  playerId: string;
  position: Position;
}

export interface ProjectileCreatedMessage extends JSONMessage {
  type: 'projectileCreated';
  projectileId: string;
  ownerId: string;
  position: Position;
  velocity: Velocity;
}

export interface ProjectileUpdateMessage extends JSONMessage {
  type: 'projectileUpdate';
  projectileId: string;
  position: Position;
}

export interface ProjectileDestroyedMessage extends JSONMessage {
  type: 'projectileDestroyed';
  projectileId: string;
}
