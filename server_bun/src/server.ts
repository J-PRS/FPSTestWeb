import { CONFIG } from './config.ts';
import { GameServer } from './GameServer.ts';
import { logger } from './logger.ts';
import type { WebSocketData } from './types.ts';
import { DemoStorage } from './DemoStorage.ts';
import { RtcRelay } from './RtcRelay.ts';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

const gameServer = new GameServer();
const demoStorage = new DemoStorage(join(import.meta.dir, '..', 'demos'));
// P2P signalling: /rtc sockets never touch GameServer — the relay just
// shuttles SDP/ICE between the two members of a room.
const rtcRelay = new RtcRelay();

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
  hostname: '0.0.0.0',
  idleTimeout: CONFIG.idleTimeoutSec,

  websocket: {
    data: {} as WebSocketData,
    maxPayloadLength: CONFIG.maxPayloadLength,

    open(ws) {
      if (ws.data.rtc) { rtcRelay.onOpen(ws); return; }
      gameServer.onOpen(ws);
    },

    message(ws, message) {
      if (ws.data.rtc) { rtcRelay.onMessage(ws, message as string | ArrayBuffer); return; }
      gameServer.onMessage(ws, message as string | ArrayBuffer);
    },

    close(ws) {
      if (ws.data.rtc) { rtcRelay.onClose(ws); return; }
      gameServer.onClose(ws);
    },

    drain(ws) {
      if (ws.data.rtc) return;
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

    // P2P signalling: /rtc?room=CODE — two sockets per room, opaque relay.
    if (url.pathname === '/rtc') {
      const room = url.searchParams.get('room') ?? '';
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(room)) {
        return new Response('Bad room', { status: 400 });
      }
      if (server.upgrade(req, { data: { playerId: '', connectedAt: Date.now(), rtc: true, room } })) {
        return;
      }
      return new Response('Upgrade failed', { status: 400 });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return corsResponse(JSON.stringify(gameServer.getHealthStatus()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Ops metrics: GET /metrics — uptime, players, balls, message counts,
    // tick-lag stats (setInterval drift behind wall time).
    if (url.pathname === '/metrics') {
      return corsResponse(JSON.stringify(gameServer.getMetrics()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Lobby browse: GET /rooms — live matches with occupancy.
    if (url.pathname === '/rooms') {
      return corsResponse(JSON.stringify(gameServer.listRooms()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Match history: GET /matches — ring of recent matchEnd/ffaMatchEnd
    // records (also journaled to logs/matches.jsonl).
    if (url.pathname === '/matches') {
      return corsResponse(JSON.stringify(gameServer.listMatches()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Leaderboard: GET /stats — lifetime per-player aggregates read off
    // the match journal (wins/kills/deaths/matches, sorted by wins).
    if (url.pathname === '/stats') {
      return corsResponse(JSON.stringify(await gameServer.getStats()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Quick-join: GET /join?mode=ctf → {room, mode} — the lobby uses it
    // to drop players into the emptiest live match of a mode.
    if (url.pathname === '/join') {
      const mode = url.searchParams.get('mode') ?? '';
      if (!/^[a-z0-9_-]{0,16}$/.test(mode)) {
        return corsResponse('Bad mode', { status: 400 });
      }
      const room = gameServer.quickRoom(mode);
      return corsResponse(JSON.stringify({ room: room.name, mode: room.mode }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Demo upload: POST /demos/upload
    if (url.pathname === '/demos/upload' && req.method === 'POST') {
      try {
        // Reject oversized uploads before buffering the body — clips are
        // ~seconds of binary frames, 16MB is a generous ceiling
        const contentLength = Number(req.headers.get('content-length') ?? 0);
        if (contentLength > 16 * 1024 * 1024) {
          return corsResponse(JSON.stringify({ success: false, error: 'Upload too large' }), {
            status: 413,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const body = await req.arrayBuffer();
        if (body.byteLength > 16 * 1024 * 1024) {
          return corsResponse(JSON.stringify({ success: false, error: 'Upload too large' }), {
            status: 413,
            headers: { 'Content-Type': 'application/json' },
          });
        }
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

    // Client log shipping: POST /client-log — appended to logs/client.log.
    // Bodies are plain text lines (WARN/ERROR only by client convention).
    // Lines also fan out by level: client_warning.log / client_error.log.
    const LOGS_DIR = join(import.meta.dir, '..', '..', 'logs');
    if (url.pathname === '/client-log' && req.method === 'POST') {
      try {
        const body = await req.text();
        if (body.length > 512 * 1024) {
          return corsResponse('Too large', { status: 413 });
        }
        mkdirSync(LOGS_DIR, { recursive: true });
        appendFileSync(join(LOGS_DIR, 'client.log'), body);
        const warnLines: string[] = [];
        const errLines: string[] = [];
        for (const line of body.split('\n')) {
          if (!line) continue;
          if (line.includes('[ERROR]')) errLines.push(line);
          else if (line.includes('[WARN]')) warnLines.push(line);
        }
        if (warnLines.length) appendFileSync(join(LOGS_DIR, 'client_warning.log'), warnLines.join('\n') + '\n');
        if (errLines.length) appendFileSync(join(LOGS_DIR, 'client_error.log'), errLines.join('\n') + '\n');
        return corsResponse('ok');
      } catch (e) {
        logger.warn('Client log append failed', { error: (e as Error).message });
        return corsResponse('append failed', { status: 500 });
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
});

logger.info(`WebSocket: ws://localhost:${CONFIG.port}/ws`);
logger.info(`Health:    http://localhost:${CONFIG.port}/health`);
logger.info(`RTC relay: ws://localhost:${CONFIG.port}/rtc?room=CODE`);

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
