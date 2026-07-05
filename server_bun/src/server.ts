import { CONFIG } from './config.ts';
import { GameServer } from './GameServer.ts';
import { logger } from './logger.ts';
import type { WebSocketData } from './types.ts';

const gameServer = new GameServer();

const server = Bun.serve<WebSocketData>({
  port: CONFIG.port,
  maxPayloadLength: CONFIG.maxPayloadLength,
  idleTimeout: CONFIG.idleTimeoutSec,

  websocket: {
    data: {} as WebSocketData,

    open(ws) {
      gameServer.onOpen(ws);
    },

    message(ws, message) {
      gameServer.onMessage(ws, message as string | ArrayBuffer);
    },

    close(ws) {
      gameServer.onClose(ws);
    },

    drain(ws) {
      gameServer.onDrain(ws);
    },
  },

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      if (server.upgrade(req, { data: { playerId: '', connectedAt: Date.now() } })) {
        return;
      }
      return new Response('Upgrade failed', { status: 400 });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json(gameServer.getHealthStatus());
    }

    return new Response('Not found', { status: 404 });
  },
});

gameServer.setBunServer(server);

logger.info('FPS Bun Server started', {
  port: CONFIG.port,
  tickRate: CONFIG.tickRate,
  maxPlayers: CONFIG.maxPlayers,
  respawnMs: CONFIG.respawnDelayMs,
  shotDamage: CONFIG.shotDamage,
});

logger.info(`WebSocket: ws://localhost:${CONFIG.port}/ws`);
logger.info(`Health:    http://localhost:${CONFIG.port}/health`);

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  gameServer.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  gameServer.stop();
  process.exit(0);
});
