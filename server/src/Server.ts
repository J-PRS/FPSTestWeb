/**
 * Main server entry point - modular architecture
 */


import uWS from 'uwebsockets.js';
import { PlayerManager } from './PlayerManager.js';
import { ProjectileManager } from './ProjectileManager.js';
import { MessageHandler } from './MessageHandler.js';
import { GameLoop } from './GameLoop.js';
import { Logger } from './Logger.js';
import { PositionValidator } from './PositionValidator.js';
import { ServerConfig, NetworkMode } from './config.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import { RoomManager } from './RoomManager.js';
import { Tribes2Networking } from './Tribes2Networking.js';
import { NetworkModeHandler } from './NetworkModeHandler.js';
import { RelayModeHandler } from './RelayModeHandler.js';
import { ServerAuthoritativeHandler } from './ServerAuthoritativeHandler.js';
// import { StateSnapshot } from './StateSnapshot.js'; // Temporarily disabled due to crash
// import type { WebSocket, WebSocketBehavior, App } from './WebSocketTypes.js';

/**
 * Validate playerId format to prevent injection attacks
 * PlayerId should be alphanumeric with reasonable length
 */
function isValidPlayerId(playerId: string): boolean {
  if (!playerId || typeof playerId !== 'string') return false;
  if (playerId.length < 1 || playerId.length > 50) return false;
  // Allow alphanumeric, underscore, hyphen
  return /^[a-zA-Z0-9_-]+$/.test(playerId);
}

// Set log level from config
Logger.setLogLevel(ServerConfig.LOG_LEVEL);

// Initialize file logging
Logger.initFileLogging();

// Initialize state snapshot system (temporarily disabled)
// StateSnapshot.init();

class Server {
  private playerManager: PlayerManager;
  private projectileManager: ProjectileManager;
  private messageHandler: MessageHandler;
  private gameLoop: GameLoop;
  private app: any; // uWS.js App - complex generic types, using any due to library limitations
  private positionValidator: PositionValidator;
  private performanceMonitor: PerformanceMonitor;
  private roomManager: RoomManager;
  private networkModeHandler: NetworkModeHandler;

  constructor() {
    try {
      this.positionValidator = new PositionValidator();
      this.playerManager = new PlayerManager(this.positionValidator);
      this.projectileManager = new ProjectileManager();
      this.performanceMonitor = new PerformanceMonitor();
      this.roomManager = new RoomManager();

      // Initialize network mode handler based on config
      if ((ServerConfig.NETWORK_MODE as string) === 'client_relay') {
        this.networkModeHandler = new RelayModeHandler();
      } else {
        // Default to server-authoritative mode - callbacks will be wired after MessageHandler is initialized
        this.networkModeHandler = new ServerAuthoritativeHandler();
      }
      
      // Create default room
      this.roomManager.createRoom('default', 'Default Lobby', 16, 'deathmatch');
      
      this.gameLoop = new GameLoop(
        this.playerManager,
        this.projectileManager,
        this.broadcastToAll.bind(this),
        ServerConfig.TICK_RATE,
        this.performanceMonitor
      );

      // Wire ghost update callback to Tribes2Networking
      if (this.networkModeHandler instanceof ServerAuthoritativeHandler) {
        this.gameLoop.setGhostUpdateCallback((playerId: string, position: any, rotation: any, velocity: any) => {
          // Update ghost for all other connections (not the player themselves)
          for (const [otherPlayerId, player] of this.playerManager.getPlayers()) {
            if (otherPlayerId !== playerId && !player.disconnected) {
              (this.networkModeHandler as ServerAuthoritativeHandler).sendPosition(otherPlayerId, playerId, position, rotation);
            }
          }
        });
      }
      this.messageHandler = new MessageHandler(
        this.playerManager,
        this.projectileManager,
        this.broadcastToAll.bind(this),
        this.positionValidator,
        this.performanceMonitor
      );

      // Wire network mode handler callbacks to MessageHandler (after MessageHandler is initialized)
      if (this.networkModeHandler instanceof ServerAuthoritativeHandler) {
        this.networkModeHandler.onEvent((connectionId: string, event: any) => {
          // Convert Tribes2 events to MessageHandler format
          // connectionId is already the playerId in Tribes2Networking
          const playerId = connectionId;

          if (event.type === 1) {
            // PositionEvent - convert to position message
            this.messageHandler.handleMessage(playerId, {
              type: 'position',
              data: {
                x: event.position.x,
                y: event.position.y,
                z: event.position.z,
                yaw: event.rotation.yaw,
                pitch: event.rotation.pitch
              }
            });
          } else if (event.type === 2) {
            // ShotEvent
            this.messageHandler.handleMessage(playerId, {
              type: 'shot',
              data: {
                targetId: event.targetId,
                timestamp: event.timestamp
              }
            });
          }
        });

        this.networkModeHandler.onMove((connectionId: string, move: any) => {
          // Convert Tribes2 moves to MessageHandler format
          // connectionId is already the playerId in Tribes2Networking
          const playerId = connectionId;

          this.messageHandler.handleMessage(playerId, {
            type: 'input',
            data: {
              input: {
                forward: move.input.forward,
                right: move.input.right,
                jump: move.input.jump === 1,
                ski: move.input.ski === 1
              },
              rotation: {
                yaw: move.rotation.yaw,
                pitch: move.rotation.pitch
              },
              sequenceNumber: move.sequence
            }
          });
        });

        // Set control object provider for client-side prediction
        this.networkModeHandler.setControlObjectProvider((connectionId: string) => {
          const playerId = this.playerManager.getPlayerIdByConnectionId(connectionId);
          if (!playerId) {
            return null;
          }
          const player = this.playerManager.getPlayer(playerId);
          if (!player) {
            return null;
          }
          return {
            position: player.position,
            rotation: player.rotation,
            velocity: player.velocity
          };
        });
      }
    } catch (error) {
      Logger.error(`Server initialization error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  start(): void {
    Logger.info(`Starting on port ${ServerConfig.PORT} with ${ServerConfig.TICK_RATE}Hz tick rate`);

    // Start performance monitoring
    this.performanceMonitor.startMonitoring(() => ({
      playerCount: this.playerManager.getPlayerCount(),
      messageQueueSize: this.playerManager.getMessageQueueSize(),
      tickRate: ServerConfig.TICK_RATE
    }));

    this.app = uWS.App({
      key_file_name: '',
      cert_file_name: '',
    }).ws('/*', {
      compression: 0,
      maxPayloadLength: 16 * 1024 * 1024,
      idleTimeout: 60,
      open: (ws: any) => {
        this.handleConnection(ws);
      },
      message: (ws: any, message: ArrayBuffer, _isBinary: boolean) => {
        this.handleMessage(ws, Buffer.from(message));
      },
      close: (ws: any, _code: number, _message: ArrayBuffer) => {
        this.handleClose(ws);
      },
    }).listen(ServerConfig.PORT, (token: any) => {
      if (token) {
        Logger.info(`Listening on port ${ServerConfig.PORT}`);
        this.gameLoop.start();
      } else {
        Logger.error(`Failed to listen on port ${ServerConfig.PORT}`);
      }
    });

    // Handle process exit to close log file
    process.on('SIGINT', () => {
      Logger.info('Shutting down server...');
      Logger.closeFileLogging();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      Logger.info('Shutting down server...');
      Logger.closeFileLogging();
      process.exit(0);
    });
  }

  private handleConnection(ws: any): void {
    const wsToPlayerId = this.playerManager.getWsToPlayerId();
    wsToPlayerId.set(ws, ''); // empty string means not yet identified
    Logger.debug('New WebSocket connection, waiting for join message');
  }

  /**
   * Manually trigger a state snapshot for debugging
   */
  takeSnapshot(): void {
    // Temporarily disabled due to crash
    Logger.warn('State snapshot temporarily disabled');
    /*
    const players = this.playerManager.getPlayers();
    const projectiles = this.projectileManager.getProjectiles();
    const snapshot = StateSnapshot.create(players, projectiles, 'server');
    const filepath = StateSnapshot.save(snapshot);
    Logger.info(`State snapshot saved to ${filepath}`);
    */
  }

  /**
   * Request rough state comparison from all clients
   */
  requestRoughStates(): void {
    this.messageHandler.requestRoughStates();
  }

  private handleMessage(ws: any, data: Buffer): void {
    const wsToPlayerId = this.playerManager.getWsToPlayerId();
    const playerId = wsToPlayerId.get(ws);

    if (!playerId) {
      // First message should be join (JSON)
      // Check if data looks like JSON (starts with '{')
      const firstByte = data[0];
      if (firstByte === 0x7B) { // '{' character
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'join') {
            this.handleJoin(ws, message, message.roomId || 'default');
          } else {
            Logger.warn('First message must be join');
          }
        } catch (e) {
          Logger.error('Failed to parse first message', e);
        }
      } else {
        Logger.warn('First message must be JSON join message, got binary data');
      }
      return;
    }

    // Handle subsequent messages - check if binary or JSON
    const firstByte = data[0];
    if (firstByte === 0x7B) { // JSON message (starts with '{')
      try {
        const message = JSON.parse(data.toString());
        this.messageHandler.handleMessage(playerId, message);
      } catch (e) {
        Logger.error('Failed to parse JSON message', e);
      }
    } else {
      // Binary message - only handle if network mode handler is initialized for this connection
      if (this.networkModeHandler.isConnectionInitialized(playerId)) {
        this.networkModeHandler.handlePacket(playerId, new Uint8Array(data));
      } else {
        Logger.warn(`Ignoring binary packet from ${playerId} - connection not initialized yet`);
      }
    }
  }

  private handleJoin(ws: any, message: any, roomId: string = 'default'): void {
    const playerId = message.playerId;

    // Validate playerId to prevent injection attacks
    if (!isValidPlayerId(playerId)) {
      Logger.warn(`Invalid playerId format rejected: ${playerId}`);
      ws.close();
      return;
    }

    Logger.info(`PLAYER CONNECTED: ${playerId} to room: ${roomId}`);

    // Send join acknowledgment before initializing Tribes2 networking
    ws.send(JSON.stringify({
      type: 'joinAck',
      playerId,
      roomId
    }));

    // Initialize Tribes2 networking for this connection
    this.networkModeHandler.initializeConnection(playerId, (connId: string, data: Uint8Array) => {
      ws.send(Buffer.from(data), true); // true = isBinary
    });

    // Mark join handshake as complete to allow binary packet transmission
    this.networkModeHandler.markJoinHandshakeComplete(playerId);

    const existingPlayer = this.playerManager.getPlayer(playerId);
    const room = this.roomManager.getRoom(roomId);

    if (!room) {
      Logger.warn(`Room ${roomId} not found, using default room`);
      this.roomManager.createRoom('default', 'Default Lobby', 16, 'deathmatch');
    }

    if (existingPlayer && existingPlayer.disconnected) {
      // Reconnecting player - restore state
      Logger.info(`Player ${playerId} reconnecting, restoring state`);
      this.playerManager.restorePlayer(playerId, ws);
      this.roomManager.addPlayerToRoom(playerId, existingPlayer, roomId);

      // Send current state back to player
      const roomPlayers = this.roomManager.getRoomPlayers(roomId);
      const otherPlayers = Array.from(roomPlayers.entries())
        .filter(([id]) => id !== playerId)
        .map(([id, data]) => ({
          playerId: id,
          position: data.position,
          rotation: data.rotation,
          velocity: data.velocity,
          health: data.health,
          isDead: data.isDead
        }));

      ws.send(JSON.stringify({
        type: 'gameState',
        roomId,
        players: otherPlayers,
        localPlayerState: {
          position: existingPlayer.position,
          rotation: existingPlayer.rotation,
          velocity: existingPlayer.velocity,
          health: existingPlayer.health,
          isDead: existingPlayer.isDead,
          lastProcessedSequence: existingPlayer.lastProcessedSequence
        }
      }));

      Logger.info(`Sent gameState to reconnecting player ${playerId} in room ${roomId} with ${otherPlayers.length} other players`);
    } else if (existingPlayer) {
      // Player claims to be connected but sent a new join - treat as reconnect
      Logger.info(`Player ${playerId} re-joining, treating as reconnect`);
      existingPlayer.disconnected = true; // force reconnect path
      this.playerManager.restorePlayer(playerId, ws);
      this.roomManager.addPlayerToRoom(playerId, existingPlayer, roomId);

      const roomPlayers = this.roomManager.getRoomPlayers(roomId);
      const otherPlayers = Array.from(roomPlayers.entries())
        .filter(([id]) => id !== playerId)
        .map(([id, data]) => ({
          playerId: id,
          position: data.position,
          rotation: data.rotation,
          velocity: data.velocity,
          health: data.health,
          isDead: data.isDead
        }));

      ws.send(JSON.stringify({
        type: 'gameState',
        roomId,
        players: otherPlayers,
        localPlayerState: {
          position: existingPlayer.position,
          rotation: existingPlayer.rotation,
          velocity: existingPlayer.velocity,
          health: existingPlayer.health,
          isDead: existingPlayer.isDead,
          lastProcessedSequence: existingPlayer.lastProcessedSequence
        }
      }));

      Logger.info(`Sent gameState to re-joining player ${playerId} in room ${roomId} with ${otherPlayers.length} other players`);
      return;
    } else {
      // New player - use client-sent position (has terrain data)
      const spawnPosition = message.position || { x: 0, y: 0, z: 0 };
      this.playerManager.addPlayer(playerId, ws, spawnPosition);
      const newPlayer = this.playerManager.getPlayer(playerId);
      
      if (newPlayer) {
        this.roomManager.addPlayerToRoom(playerId, newPlayer, roomId);
      }

      // Send existing players to new player
      const roomPlayers = this.roomManager.getRoomPlayers(roomId);
      const existingPlayers = Array.from(roomPlayers.entries())
        .filter(([id]) => id !== playerId)
        .map(([id, data]) => ({
          playerId: id,
          position: data.position,
          rotation: data.rotation,
          velocity: data.velocity,
          health: data.health,
          isDead: data.isDead
        }));

      ws.send(JSON.stringify({
        type: 'gameState',
        roomId,
        players: existingPlayers
      }));

      Logger.info(`Sent gameState to new player ${playerId} in room ${roomId} with ${existingPlayers.length} other players`);

      // Broadcast new player join to others in room
      this.roomManager.broadcastToRoom(roomId, {
        type: 'playerJoined',
        playerId,
        position: newPlayer?.position || { x: 0, y: 0, z: 0 },
        rotation: newPlayer?.rotation || { yaw: 0, pitch: 0 },
        isDead: newPlayer?.isDead || false
      }, playerId);
    }
  }

  private handleClose(ws: any): void {
    const wsToPlayerId = this.playerManager.getWsToPlayerId();
    const playerId = wsToPlayerId.get(ws);
    wsToPlayerId.delete(ws);

    if (playerId && playerId !== '') {
      Logger.info(`PLAYER DISCONNECTED: ${playerId}`);
      this.playerManager.markPlayerDisconnected(playerId);
      this.messageHandler.cleanupPlayer(playerId);
      this.roomManager.removePlayerFromRoom(playerId);
      this.networkModeHandler.removeConnection(playerId);
      // Clean up projectiles from disconnected player to prevent memory leaks
      const removedProjectiles = this.projectileManager.removeProjectilesByOwner(playerId);
      if (removedProjectiles.length > 0) {
        Logger.debug(`Cleaned up ${removedProjectiles.length} projectiles from disconnected player ${playerId}`);
      }
    }
  }

  private handleError(ws: any, error: Error): void {
    const wsToPlayerId = this.playerManager.getWsToPlayerId();
    const playerId = wsToPlayerId.get(ws) || 'unknown';
    Logger.error(`WebSocket error for ${playerId}`, error);
  }

  private broadcastToAll(message: any, excludePlayerId?: string): void {
    const data = JSON.stringify(message);
    const dataSize = data.length;
    let sentCount = 0;
    for (const [playerId, player] of this.playerManager.getPlayers()) {
      if (playerId !== excludePlayerId && !player.disconnected) {
        player.ws.send(data);
        sentCount++;
      }
    }
    // Record bandwidth usage
    this.performanceMonitor.recordBandwidth(dataSize * sentCount, 0);
  }
}

// Start server
const server = new Server();
server.start();
