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

  /** Binary hot-path frames (tickUpdate) — no JSON.stringify. Rides the
   *  reliable lane on every transport: measured WT datagram loss on
   *  loopback was ~47%, which played as remote stutter + a bogus loss
   *  reading, and the datagram lane buys nothing when it's dropping half
   *  the frames anyway. Revisit if the QUIC lane proves reliable. */
  sendBinaryToPlayer(playerId: string, data: Uint8Array): void {
    const ws = this.connections.get(playerId);
    if (ws && ws.readyState === 1) {
      ws.send(data);
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
