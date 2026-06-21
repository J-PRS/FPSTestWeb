/**
 * Type definitions for the game server
 */

import { WebSocket } from 'ws';

export interface PlayerState {
  ws: WebSocket;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
  velocity: { x: number; y: number; z: number };
  lastProcessedSequence: number;
  health: number;
  isDead: boolean;
  respawnTime: number | null;
  disconnected: boolean;
  disconnectTime: number | null;
  playerLeftBroadcasted: boolean;
  lastUpdateTime: number;
}

export interface PositionSnapshot {
  timestamp: number;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
}

export interface Projectile {
  id: string;
  ownerId: string;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  createdAt: number;
}

export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  jetpack: boolean;
  shoot: boolean;
  sequenceNumber: number;
  timestamp: number;
}
