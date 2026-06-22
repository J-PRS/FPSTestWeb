/**
 * Player state management
 */

import { WebSocket } from 'ws';
import { PlayerState, PositionSnapshot } from './types.js';

export class PlayerManager {
  private players: Map<string, PlayerState> = new Map();
  private rewindBuffer: Map<string, PositionSnapshot[]> = new Map();
  private wsToPlayerId: Map<WebSocket, string> = new Map();

  getPlayers(): Map<string, PlayerState> {
    return this.players;
  }

  getRewindBuffer(): Map<string, PositionSnapshot[]> {
    return this.rewindBuffer;
  }

  getWsToPlayerId(): Map<WebSocket, string> {
    return this.wsToPlayerId;
  }

  getPlayer(playerId: string): PlayerState | undefined {
    return this.players.get(playerId);
  }

  addPlayer(playerId: string, ws: WebSocket, position: { x: number; y: number; z: number }): void {
    this.players.set(playerId, {
      ws,
      position,
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      lastProcessedSequence: 0,
      health: 100,
      isDead: false,
      respawnTime: null,
      disconnected: false,
      disconnectTime: null,
      playerLeftBroadcasted: false,
      lastUpdateTime: Date.now()
    });
    this.rewindBuffer.set(playerId, []);
    this.wsToPlayerId.set(ws, playerId);
  }

  updateLastProcessedSequence(playerId: string, sequence: number): void {
    const player = this.players.get(playerId);
    if (player) {
      player.lastProcessedSequence = sequence;
    }
  }

  getLastProcessedSequence(playerId: string): number {
    const player = this.players.get(playerId);
    return player ? player.lastProcessedSequence : 0;
  }

  restorePlayer(playerId: string, ws: WebSocket): void {
    const player = this.players.get(playerId);
    if (player) {
      player.ws = ws;
      player.disconnected = false;
      player.disconnectTime = null;
      player.lastUpdateTime = Date.now();
      this.rewindBuffer.set(playerId, []);
      this.wsToPlayerId.set(ws, playerId);
    }
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      this.wsToPlayerId.delete(player.ws);
    }
    this.players.delete(playerId);
    this.rewindBuffer.delete(playerId);
  }

  markPlayerDisconnected(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      player.disconnected = true;
      player.disconnectTime = Date.now();
    }
  }

  storePlayerPosition(playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }): void {
    const history = this.rewindBuffer.get(playerId) || [];
    history.push({
      timestamp: Date.now(),
      position: { ...position },
      rotation: { ...rotation }
    });

    // Keep 500ms history for lag compensation
    const cutoff = Date.now() - 500;
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }

    this.rewindBuffer.set(playerId, history);
  }

  getPlayerPositionAt(playerId: string, timestamp: number): { position: { x: number; y: number; z: number }; rotation: { yaw: number; pitch: number } } | null {
    const history = this.rewindBuffer.get(playerId);
    if (!history || history.length === 0) return null;

    // Find closest snapshot
    let closest = history[0];
    let closestDiff = Math.abs(history[0].timestamp - timestamp);

    for (const snapshot of history) {
      const diff = Math.abs(snapshot.timestamp - timestamp);
      if (diff < closestDiff) {
        closest = snapshot;
        closestDiff = diff;
      }
    }

    // Only return if within 100ms
    if (closestDiff > 100) return null;

    return {
      position: { ...closest.position },
      rotation: { ...closest.rotation }
    };
  }
}
