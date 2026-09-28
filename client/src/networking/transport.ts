/**
 * Transport seam — the shape NetworkManager needs from a connection.
 * WebSocketConnection already satisfies this; P2P transports (loopback for
 * the host's own client, RTCDataChannel for the guest) plug in the same way.
 */

import type { ConnectionConfig } from './WebSocketConnection.js';

export interface GameTransport {
  connect(url?: string): void;
  send(data: string | Uint8Array): boolean;
  /** Fire-and-forget lane for volatile state (position frames). Transports
   *  without a second lane just send() — same wire, degraded semantics. */
  sendUnreliable?(data: string | Uint8Array): boolean;
  connected(): boolean;
  disconnect(): void;
  /** Which netcode-v2 tier this transport is — reported in the join so
   *  /metrics shows the real deployment's transport mix. */
  readonly tier?: 'wt' | 'rtc' | 'ws' | 'p2p' | 'host';
}

export type TransportFactory = (config: ConnectionConfig) => GameTransport;
