import type { ServerWebSocket } from 'bun';
import type { WebSocketData, ServerMessage } from './types.ts';
import { logger } from './logger.ts';

const ROOM_TOPIC = 'game-room';

export class ConnectionManager {
  private connections: Map<string, ServerWebSocket<WebSocketData>> = new Map();

  register(playerId: string, ws: ServerWebSocket<WebSocketData>): void {
    this.connections.set(playerId, ws);
    ws.subscribe(ROOM_TOPIC);
    logger.info(`Connection registered`, { playerId, total: this.connections.size });
  }

  unregister(playerId: string): void {
    const ws = this.connections.get(playerId);
    if (ws) {
      ws.unsubscribe(ROOM_TOPIC);
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
