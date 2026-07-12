import { CONFIG } from './config.ts';
import { GameServer } from './GameServer.ts';
import { logger } from './logger.ts';
import type { WebSocketData } from './types.ts';
import { DemoStorage } from './DemoStorage.ts';
import { join } from 'node:path';

const gameServer = new GameServer();
const demoStorage = new DemoStorage(join(import.meta.dir, '..', 'demos'));

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body: BodyInit | null, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

const server = Bun.serve<WebSocketData>({
  port: CONFIG.port,
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

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return corsResponse(null, { status: 204 });
    }

    if (url.pathname === '/ws') {
      if (server.upgrade(req, { data: { playerId: '', connectedAt: Date.now() } })) {
        return;
      }
      return new Response('Upgrade failed', { status: 400 });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return corsResponse(JSON.stringify(gameServer.getHealthStatus()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Demo upload: POST /demos/upload
    if (url.pathname === '/demos/upload' && req.method === 'POST') {
      try {
        const body = await req.arrayBuffer();
        logger.info('Demo upload received', { size: body.byteLength });
        const meta = await demoStorage.saveDemo(body);
        if (!meta.filename) {
          return corsResponse(JSON.stringify({ success: false, rejected: true, reason: 'Below minimum lifetime' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return corsResponse(JSON.stringify({ success: true, ...meta }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        logger.warn('Demo upload failed', { error: (e as Error).message });
        return corsResponse(JSON.stringify({ success: false, error: (e as Error).message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Demo list: GET /demos
    if (url.pathname === '/demos' && req.method === 'GET') {
      const list = await demoStorage.listDemos();
      logger.info('Demo list requested', { count: list.length, top: list[0]?.projectileLifetime.toFixed(2) ?? 'none' });
      return corsResponse(JSON.stringify({ demos: list }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Demo download: GET /demos/:filename
    if (url.pathname.startsWith('/demos/') && req.method === 'GET') {
      const filename = url.pathname.slice('/demos/'.length);
      if (filename === 'upload' || filename === '') {
        return corsResponse('Not found', { status: 404 });
      }
      const data = await demoStorage.loadDemo(filename);
      if (!data) {
        logger.info('Demo download not found', { filename });
        return corsResponse('Not found', { status: 404 });
      }
      logger.info('Demo downloaded', { filename, size: data.byteLength });
      return corsResponse(data, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }

    return corsResponse('Not found', { status: 404 });
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
