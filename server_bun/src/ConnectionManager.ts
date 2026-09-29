import type { ServerWebSocket } from 'bun';
import type { WebSocketData, ServerMessage } from './types.ts';
import { logger } from './logger.ts';

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

  /** Binary hot-path frames (tickUpdate) — no JSON.stringify.
   *  Transports that expose `sendUnreliable` (WT datagram lane) use it;
   *  plain WS has no UDP lane so everything rides the same stream. */
  sendBinaryToPlayer(playerId: string, data: Uint8Array): void {
    const ws = this.connections.get(playerId) as (ServerWebSocket<WebSocketData> & { sendUnreliable?(d: Uint8Array): number }) | undefined;
    if (ws && ws.readyState === 1) {
      (ws.sendUnreliable ?? ws.send).call(ws, data);
    }
  }

  /** High-rate binary broadcasts (ball segments) — encode once, send raw. */
  broadcastBinary(data: Uint8Array): void {
    this.connections.forEach((ws) => {
      if (ws.readyState === 1) {
        const w = ws as ServerWebSocket<WebSocketData> & { sendUnreliable?(d: Uint8Array): number };
        (w.sendUnreliable ?? w.send).call(w, data);
      }
    });
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
