/**
 * Main server entry point - modular architecture
 */

import { WebSocketServer, WebSocket } from 'ws';
import { PlayerManager } from './PlayerManager.js';
import { ProjectileManager } from './ProjectileManager.js';
import { MessageHandler } from './MessageHandler.js';
import { GameLoop } from './GameLoop.js';

const PORT = 8095;
const TICK_RATE = 15; // 15Hz = 67ms per tick

class Server {
  private playerManager: PlayerManager;
  private projectileManager: ProjectileManager;
  private messageHandler: MessageHandler;
  private gameLoop: GameLoop;
  private wss: WebSocketServer;

  constructor() {
    this.playerManager = new PlayerManager();
    this.projectileManager = new ProjectileManager();
    this.gameLoop = new GameLoop(
      this.playerManager,
      this.projectileManager,
      this.broadcastToAll.bind(this),
      TICK_RATE
    );
    this.messageHandler = new MessageHandler(
      this.playerManager,
      this.projectileManager,
      this.broadcastToAll.bind(this)
    );
    this.wss = new WebSocketServer({ port: PORT });
  }

  start(): void {
    console.log(`[Server] Starting on port ${PORT} with ${TICK_RATE}Hz tick rate`);

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.gameLoop.start();
  }

  private handleConnection(ws: WebSocket): void {
    const wsToPlayerId = this.playerManager.getWsToPlayerId();
    wsToPlayerId.set(ws, ''); // empty string means not yet identified
    console.log('[Server] New WebSocket connection, waiting for join message');

    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, data);
    });

    ws.on('close', () => {
      this.handleClose(ws);
    });

    ws.on('error', (error: Error) => {
      this.handleError(ws, error);
    });
  }

  private handleMessage(ws: WebSocket, data: Buffer): void {
    const wsToPlayerId = this.playerManager.getWsToPlayerId();
    const playerId = wsToPlayerId.get(ws);

    if (!playerId) {
      // First message should be join (JSON)
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'join') {
          this.handleJoin(ws, message.playerId);
        } else {
          console.warn('[Server] First message must be join');
        }
      } catch (e) {
        console.error('[Server] Failed to parse first message:', e);
      }
      return;
    }

    // Handle subsequent messages - could be binary or JSON
    try {
      // Try JSON first (for join/jump/jetpack messages)
      const message = JSON.parse(data.toString());
      this.messageHandler.handleMessage(playerId, message);
    } catch (e) {
      // If not JSON, treat as binary
      this.messageHandler.handleBinaryMessage(playerId, data);
    }
  }

  private handleJoin(ws: WebSocket, playerId: string): void {
    console.log(`[Server] Join message from: ${playerId}`);

    const wsToPlayerId = this.playerManager.getWsToPlayerId();
    const existingPlayer = this.playerManager.getPlayer(playerId);

    if (existingPlayer && existingPlayer.disconnected) {
      // Reconnecting player - restore state
      console.log(`[Server] Player ${playerId} reconnecting, restoring state`);
      this.playerManager.restorePlayer(playerId, ws);

      // Send current state back to player
      const otherPlayers = Array.from(this.playerManager.getPlayers().entries())
        .filter(([id]) => id !== playerId)
        .map(([id, data]) => ({
          playerId: id,
          position: data.position,
          rotation: data.rotation,
          health: data.health,
          isDead: data.isDead
        }));

      ws.send(JSON.stringify({
        type: 'gameState',
        players: otherPlayers,
        localPlayerState: {
          position: existingPlayer.position,
          rotation: existingPlayer.rotation,
          health: existingPlayer.health,
          isDead: existingPlayer.isDead
        }
      }));

      console.log(`[Server] Sent gameState to reconnecting player ${playerId} with ${otherPlayers.length} other players`);
    } else if (existingPlayer) {
      // Player claims to be connected but sent a new join - treat as reconnect
      // (their old ws may have closed before we processed it)
      console.log(`[Server] Player ${playerId} re-joining, treating as reconnect`);
      existingPlayer.disconnected = true; // force reconnect path
      this.playerManager.restorePlayer(playerId, ws);

      const otherPlayers = Array.from(this.playerManager.getPlayers().entries())
        .filter(([id]) => id !== playerId)
        .map(([id, data]) => ({
          playerId: id,
          position: data.position,
          rotation: data.rotation,
          health: data.health,
          isDead: data.isDead
        }));

      ws.send(JSON.stringify({
        type: 'gameState',
        players: otherPlayers,
        localPlayerState: {
          position: existingPlayer.position,
          rotation: existingPlayer.rotation,
          health: existingPlayer.health,
          isDead: existingPlayer.isDead
        }
      }));

      console.log(`[Server] Sent gameState to re-joining player ${playerId} with ${otherPlayers.length} other players`);
      return;
    } else {
      // New player - initialize state
      this.playerManager.addPlayer(playerId, ws, { x: 0, y: 0, z: 0 });

      // Send existing players to new player
      const existingPlayers = Array.from(this.playerManager.getPlayers().entries())
        .filter(([id]) => id !== playerId)
        .map(([id, data]) => ({
          playerId: id,
          position: data.position,
          rotation: data.rotation,
          health: data.health,
          isDead: data.isDead
        }));

      ws.send(JSON.stringify({
        type: 'gameState',
        players: existingPlayers
      }));

      console.log(`[Server] Sent gameState to new player ${playerId} with ${existingPlayers.length} other players`);

      // Broadcast new player join to others
      this.broadcastToAll({
        type: 'playerJoined',
        playerId
      }, playerId);
    }
  }

  private handleClose(ws: WebSocket): void {
    const wsToPlayerId = this.playerManager.getWsToPlayerId();
    const playerId = wsToPlayerId.get(ws);
    wsToPlayerId.delete(ws);

    if (playerId && playerId !== '') {
      console.log(`[Server] WebSocket closed for ${playerId}`);
      this.playerManager.markPlayerDisconnected(playerId);
    }
  }

  private handleError(ws: WebSocket, error: Error): void {
    const wsToPlayerId = this.playerManager.getWsToPlayerId();
    const playerId = wsToPlayerId.get(ws) || 'unknown';
    console.error(`[Server] WebSocket error for ${playerId}:`, error);
  }

  private broadcastToAll(message: any, excludePlayerId?: string): void {
    const data = JSON.stringify(message);
    for (const [playerId, player] of this.playerManager.getPlayers()) {
      if (playerId !== excludePlayerId && !player.disconnected && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(data);
      }
    }
  }
}

// Start server
const server = new Server();
server.start();
