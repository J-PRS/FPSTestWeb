/**
 * Player state management
 */

import { PlayerState, PositionSnapshot } from './types.js';
import { PositionValidator } from './PositionValidator.js';
import { ServerConfig } from './config.js';

export class PlayerManager {
  private players: Map<string, PlayerState> = new Map();
  private rewindBuffer: Map<string, PositionSnapshot[]> = new Map();
  private wsToPlayerId: Map<any, string> = new Map();
  private positionValidator: PositionValidator;

  constructor(positionValidator: PositionValidator) {
    this.positionValidator = positionValidator;
  }

  getPlayers(): Map<string, PlayerState> {
    return this.players;
  }

  getRewindBuffer(): Map<string, PositionSnapshot[]> {
    return this.rewindBuffer;
  }

  getWsToPlayerId(): Map<any, string> {
    return this.wsToPlayerId;
  }

  getPlayerIdByConnectionId(connectionId: string): string | undefined {
    for (const [ws, playerId] of this.wsToPlayerId.entries()) {
      if (ws === connectionId || (ws as any).id === connectionId) {
        return playerId;
      }
    }
    return undefined;
  }

  getPlayerCount(): number {
    return this.players.size;
  }

  getMessageQueueSize(): number {
    // Estimate message queue size based on player count and average pending messages
    // This is a simplified metric - actual queue tracking would require per-player message queues
    return this.players.size * 2; // Assume ~2 pending messages per player on average
  }

  getPlayer(playerId: string): PlayerState | undefined {
    return this.players.get(playerId);
  }

  addPlayer(playerId: string, ws: any, position: { x: number; y: number; z: number }): void {
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

  restorePlayer(playerId: string, ws: any): void {
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
    // Clear rewind buffer immediately to prevent memory leaks
    this.rewindBuffer.delete(playerId);
    // Clear position validator history to prevent memory leaks
    this.positionValidator.clearHistory(playerId);
  }

  storePlayerPosition(playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity?: { x: number; y: number; z: number }): void {
    const history = this.rewindBuffer.get(playerId) || [];
    history.push({
      timestamp: Date.now(),
      position: { ...position },
      rotation: { ...rotation },
      velocity: velocity ? { ...velocity } : { x: 0, y: 0, z: 0 }
    });

    // Keep history for lag compensation (configurable via ServerConfig)
    const cutoff = Date.now() - ServerConfig.REWIND_BUFFER_MS;
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

    // If within tolerance (configurable via ServerConfig), return exact position
    if (closestDiff <= ServerConfig.POSITION_TOLERANCE_MS) {
      return {
        position: { ...closest.position },
        rotation: { ...closest.rotation }
      };
    }

    // If outside buffer but within reasonable range, extrapolate using velocity
    // Extrapolate: pos = pos0 + vel * dt
    const dt = (timestamp - closest.timestamp) / ServerConfig.MILLISECONDS_PER_SECOND; // Convert to seconds
    const maxExtrapolationSec = ServerConfig.EXTRAPOLATION_MAX_MS / ServerConfig.MILLISECONDS_PER_SECOND;
    if (dt > 0 && dt < maxExtrapolationSec) { // Only extrapolate up to configured max time
      const extrapolatedPosition = {
        x: closest.position.x + (closest.velocity?.x || 0) * dt,
        y: closest.position.y + (closest.velocity?.y || 0) * dt,
        z: closest.position.z + (closest.velocity?.z || 0) * dt
      };
      
      return {
        position: extrapolatedPosition,
        rotation: { ...closest.rotation }
      };
    }

    // Too far outside buffer, return null
    return null;
  }
}
