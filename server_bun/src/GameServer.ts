import type { ServerWebSocket, Server } from 'bun';
import { CONFIG } from './config.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { ConnectionManager } from './ConnectionManager.ts';
import { MessageHandler } from './MessageHandler.ts';
import { validateMessage, validatePlayerId } from './validation.ts';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';

export class GameServer {
  private playerManager: PlayerManager;
  private rateLimiter: RateLimiter;
  private connectionManager: ConnectionManager;
  private messageHandler: MessageHandler;
  private bunServer: Server<WebSocketData> | null = null;
  private hashTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickCounter = 0;
  private lastStatusLine: string = '';
  private statusRepeatCount: number = 0;
  private lastSentPositions: Map<string, { x: number; y: number; z: number; yaw: number }> = new Map();

  constructor() {
    this.playerManager = new PlayerManager();
    this.rateLimiter = new RateLimiter();
    this.connectionManager = new ConnectionManager();

    this.messageHandler = new MessageHandler(
      this.playerManager,
      this.rateLimiter,
      (msg, exclude) => this.connectionManager.broadcast(msg, exclude),
      (pid, msg) => this.connectionManager.sendToPlayer(pid, msg),
    );

    this.startHashBroadcast();
    this.startTickBroadcast();
  }

  onOpen(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('WebSocket connection opened', { remoteAddress: ws.remoteAddress });
  }

  onMessage(ws: ServerWebSocket<WebSocketData>, message: string | ArrayBuffer): void {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      logger.warn('Failed to parse JSON', { playerId: ws.data.playerId });
      return;
    }

    const existingPlayerId = ws.data.playerId;

    if (!existingPlayerId) {
      this.handleHandshake(ws, raw);
      return;
    }

    this.handleGameMessage(existingPlayerId, raw);
  }

  private reconnectGraceMs = 10000; // Grace period for F5 reconnect
  private disconnectedPlayers: Map<string, { timeout: ReturnType<typeof setTimeout> }> = new Map();

  onClose(ws: ServerWebSocket<WebSocketData>): void {
    const playerId = ws.data.playerId;
    if (!playerId) return;

    this.connectionManager.unregister(playerId);
    this.rateLimiter.removePlayer(playerId);

    // Keep player state for grace period to allow seamless F5 reconnect
    const existingTimeout = this.disconnectedPlayers.get(playerId);
    if (existingTimeout) clearTimeout(existingTimeout.timeout);

    const timeout = setTimeout(() => {
      this.disconnectedPlayers.delete(playerId);
      this.playerManager.removePlayer(playerId);
      this.lastSentPositions.delete(playerId);
      this.connectionManager.broadcast({ type: 'playerLeft', playerId });
      logger.info('Player removed after grace period', { playerId, remaining: this.playerManager.getPlayerCount() });
    }, this.reconnectGraceMs);

    this.disconnectedPlayers.set(playerId, { timeout });
    logger.info('Player disconnected, grace period started', { playerId, graceMs: this.reconnectGraceMs });
  }

  onDrain(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('Backpressure drain', { playerId: ws.data.playerId });
  }

  getHealthStatus(): { status: string; players: number; maxPlayers: number; tickRate: number } {
    return {
      status: 'running',
      players: this.playerManager.getPlayerCount(),
      maxPlayers: CONFIG.maxPlayers,
      tickRate: CONFIG.tickRate,
    };
  }

  setBunServer(server: Server<WebSocketData>): void {
    this.bunServer = server;
  }

  stop(): void {
    this.stopHashBroadcast();
    this.stopTickBroadcast();
    if (this.bunServer) {
      this.bunServer.stop(true);
      logger.info('Server stopped');
    }
  }

  private handleHandshake(ws: ServerWebSocket<WebSocketData>, raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) {
      ws.close(1008, 'Invalid handshake');
      return;
    }

    const handshake = raw as Record<string, unknown>;
    const playerIdResult = validatePlayerId(handshake.playerId);
    if (!playerIdResult.success) {
      logger.warn('Invalid playerId rejected', { error: playerIdResult.error });
      ws.close(1008, 'Invalid playerId');
      return;
    }

    const playerId = playerIdResult.data;

    if (this.playerManager.getPlayerCount() >= CONFIG.maxPlayers) {
      ws.close(1013, 'Server full');
      return;
    }

    const existingPlayer = this.playerManager.getPlayer(playerId);
    if (existingPlayer) {
      // Check if this is a reconnect within grace period
      const disconnected = this.disconnectedPlayers.get(playerId);
      if (disconnected) {
        // Cancel grace period removal, reconnect with existing state
        clearTimeout(disconnected.timeout);
        this.disconnectedPlayers.delete(playerId);

        ws.data.playerId = playerId;
        this.connectionManager.register(playerId, ws);
        this.messageHandler.handleHandshake(playerId);

        logger.info('Player reconnected within grace period, state restored', { playerId, health: existingPlayer.health, pos: existingPlayer.position });
        return;
      }

      logger.warn('Duplicate playerId rejected', { playerId });
      ws.close(1008, 'Player ID already connected');
      return;
    }

    ws.data.playerId = playerId;
    this.playerManager.addPlayer(playerId);
    this.connectionManager.register(playerId, ws);
    this.messageHandler.handleHandshake(playerId);

    logger.info('Player connected', { playerId, total: this.playerManager.getPlayerCount() });
  }

  private handleGameMessage(playerId: string, raw: unknown): void {
    const result = validateMessage(raw);
    if (!result.success) {
      logger.warn('Invalid message rejected', { playerId, error: result.error });
      return;
    }

    this.messageHandler.handleMessage(playerId, result.data);
  }

  private startHashBroadcast(): void {
    this.hashTimer = setInterval(() => {
      const playerCount = this.playerManager.getPlayerCount();
      if (playerCount === 0) return;

      this.tickCounter++;
      const hash = this.computeStateHash();
      const timestamp = Date.now();

      this.connectionManager.broadcast({
        type: 'stateHash',
        hash,
        tick: this.tickCounter,
        playerCount,
        timestamp,
      });

      // Periodic status summary - suppress duplicates, batch with count
      const players = this.playerManager.getAllPlayers();
      const summary = Array.from(players.entries()).map(([id, p]) =>
        `${id}[${p.kills}/${p.deaths}] ${p.isDead ? 'DEAD' : `HP${p.health}`} @(${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)})`
      ).join(' | ');
      const statusLine = `Status [${playerCount} players] ${summary}`;

      if (statusLine === this.lastStatusLine) {
        this.statusRepeatCount++;
      } else {
        if (this.statusRepeatCount > 0) {
          logger.info(`${this.lastStatusLine} [x${this.statusRepeatCount + 1}]`);
          this.statusRepeatCount = 0;
        }
        logger.info(statusLine);
        this.lastStatusLine = statusLine;
      }

      logger.debug('State hash broadcast', { tick: this.tickCounter, hash, playerCount });
    }, CONFIG.hashBroadcastIntervalMs);
  }

  private stopHashBroadcast(): void {
    if (this.hashTimer) {
      clearInterval(this.hashTimer);
      this.hashTimer = null;
    }
  }

  private startTickBroadcast(): void {
    this.tickTimer = setInterval(() => {
      const players = this.playerManager.getAllPlayers();
      if (players.size === 0) return;

      // Batch all player updates into one message with delta compression
      // Only include players that have moved significantly
      const updates: Array<{
        playerId: string;
        internalId: string;
        position: { x: number; y: number; z: number };
        rotation: { yaw: number; pitch: number };
        velocity: { x: number; y: number; z: number };
        health: number;
        isDead: boolean;
      }> = [];

      for (const [playerId, p] of players) {
        // Delta compression: skip if position hasn't changed significantly
        // Threshold: 0.1m movement or 0.02rad rotation
        const lastSent = this.lastSentPositions.get(playerId);
        if (lastSent) {
          const dx = p.position.x - lastSent.x;
          const dy = p.position.y - lastSent.y;
          const dz = p.position.z - lastSent.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          const yawDiff = Math.abs(p.rotation.yaw - lastSent.yaw);
          if (distSq < 0.01 && yawDiff < 0.0004) {
            continue; // Skip — not enough movement to warrant broadcast
          }
        }
        this.lastSentPositions.set(playerId, { ...p.position, yaw: p.rotation.yaw });

        updates.push({
          playerId,
          internalId: p.internalId,
          position: p.position,
          rotation: p.rotation,
          velocity: p.velocity,
          health: p.health,
          isDead: p.isDead,
        });
      }

      if (updates.length > 0) {
        // Send each player only the updates for OTHER players
        for (const [recipientId] of players) {
          const filtered = updates.filter(u => u.playerId !== recipientId);
          if (filtered.length > 0) {
            this.connectionManager.sendToPlayer(recipientId, { type: 'tickUpdate', updates: filtered });
          }
        }
      }
    }, 50); // 20Hz tick broadcast
  }

  private stopTickBroadcast(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private computeStateHash(): string {
    const players = this.playerManager.getAllPlayers();
    const sortedIds = Array.from(players.keys()).sort();

    const playerData = sortedIds.map(id => {
      const p = players.get(id)!;
      return `${id}:${Math.round(p.position.x)},${Math.round(p.position.y)},${Math.round(p.position.z)}:${p.health}:${p.isDead ? 1 : 0}`;
    }).join('|');

    let hash = 5381;
    for (let i = 0; i < playerData.length; i++) {
      hash = ((hash << 5) + hash) + playerData.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }
}
