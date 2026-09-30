import type { ServerWebSocket } from 'bun';
import type { WebSocketData, ServerMessage } from './types.ts';
import { logger } from './logger.ts';

/** Tick frames are drop-safe (peers extrapolate), so a socket that can't
 *  drain must not queue them unboundedly — a stalled connection otherwise
 *  grows memory while the player sees a worse-than-lossy feed. Above this
 *  backlog the frame is dropped before it hits the send queue. Only the
 *  tick hot path is gated; reliable control/ball traffic still queues. */
const MAX_TICK_BACKLOG = 256 * 1024;

export class ConnectionManager {
  private connections: Map<string, ServerWebSocket<WebSocketData>> = new Map();

  register(playerId: string, ws: ServerWebSocket<WebSocketData>): void {
    this.connections.set(playerId, ws);
    logger.info(`Connection registered`, { playerId, total: this.connections.size });
  }

  unregister(playerId: string): void {
    const ws = this.connections.get(playerId);
    if (ws) {
      this.connections.delete(playerId);
      logger.info(`Connection unregistered`, { playerId, total: this.connections.size });
    }
  }

  sendToPlayer(playerId: string, msg: ServerMessage): void {
    const ws = this.connections.get(playerId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** Binary hot-path frames (tickUpdate) — no JSON.stringify. Rides the
   *  reliable lane on every transport: measured WT datagram loss on
   *  loopback was ~47%, which played as remote stutter + a bogus loss
   *  reading, and the datagram lane buys nothing when it's dropping half
   *  the frames anyway. Revisit if the QUIC lane proves reliable. */
  /** Returns 'sent' | 'backlogged' | 'gone' — the caller only counts
   *  'backlogged' as loss; a closing socket isn't a dropped frame. */
  sendBinaryToPlayer(playerId: string, data: Uint8Array): 'sent' | 'backlogged' | 'gone' {
    const ws = this.connections.get(playerId);
    if (!ws || ws.readyState !== 1) return 'gone';
    const buffered = (ws as unknown as { getBufferedAmount?(): number }).getBufferedAmount?.() ?? 0;
    if (buffered > MAX_TICK_BACKLOG) return 'backlogged';
    ws.send(data);
    return 'sent';
  }

  /** Correctness-critical binary (ball segments) — always the reliable
   *  lane. A dropped segment is a resync the client free-runs blind for
   *  ~1.2s, which is exactly the rubberband pattern; a dropped tick frame
   *  is just interpolation noise. At ~50B × ~10/s per ball this is cheap. */
  broadcastBinaryReliable(data: Uint8Array): void {
    this.connections.forEach((ws) => {
      if (ws.readyState === 1) ws.send(data);
    });
  }

  broadcast(msg: ServerMessage, excludePlayerId?: string): void {
    const data = JSON.stringify(msg);
    this.connections.forEach((ws, pid) => {
      if (excludePlayerId !== undefined && pid === excludePlayerId) return;
      if (ws.readyState === 1) {
        ws.send(data);
      }
    });
  }

  getConnection(playerId: string): ServerWebSocket<WebSocketData> | undefined {
    return this.connections.get(playerId);
  }

  isConnected(playerId: string): boolean {
    const ws = this.connections.get(playerId);
    return ws !== undefined && ws.readyState === 1;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}
