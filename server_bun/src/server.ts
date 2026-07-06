import { CONFIG } from './config.ts';
import { GameServer } from './GameServer.ts';
import { logger } from './logger.ts';
import type { WebSocketData } from './types.ts';
import { DemoStorage } from './DemoStorage.ts';
import { join } from 'node:path';

const gameServer = new GameServer();
const demoStorage = new DemoStorage(join(import.meta.dir, '..', 'demos'));

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

  async fetch(req, server) {
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

    // Demo upload: POST /demos/upload
    if (url.pathname === '/demos/upload' && req.method === 'POST') {
      try {
        const body = await req.arrayBuffer();
        const meta = await demoStorage.saveDemo(body);
        return Response.json({ success: true, ...meta });
      } catch (e) {
        logger.warn('Demo upload failed', { error: (e as Error).message });
        return Response.json({ success: false, error: (e as Error).message }, { status: 500 });
      }
    }

    // Demo list: GET /demos
    if (url.pathname === '/demos' && req.method === 'GET') {
      const list = demoStorage.listDemos();
      return Response.json({ demos: list });
    }

    // Demo download: GET /demos/:filename
    if (url.pathname.startsWith('/demos/') && req.method === 'GET') {
      const filename = url.pathname.slice('/demos/'.length);
      if (filename === 'upload' || filename === '') {
        return new Response('Not found', { status: 404 });
      }
      const data = await demoStorage.loadDemo(filename);
      if (!data) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(data, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
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
