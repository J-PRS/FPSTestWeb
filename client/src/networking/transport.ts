/**
 * Transport seam — the shape NetworkManager needs from a connection.
 * WebSocketConnection already satisfies this; P2P transports (loopback for
 * the host's own client, RTCDataChannel for the guest) plug in the same way.
 */

import type { ConnectionConfig } from './WebSocketConnection.js';

export interface GameTransport {
  connect(url?: string): void;
  send(data: string | Uint8Array): boolean;
  connected(): boolean;
  disconnect(): void;
}

export type TransportFactory = (config: ConnectionConfig) => GameTransport;
