/**
 * Transport seam — the shape NetworkManager needs from a connection.
 * WebSocketConnection already satisfies this; P2P transports (loopback for
 * the host's own client, RTCDataChannel for the guest) plug in the same way.
 */

import type { ConnectionConfig } from './WebSocketConnection.js';
import type { TransportKind } from '../../../shared/protocol.js';

export interface GameTransport {
  connect(url?: string): void;
  send(data: string | Uint8Array): boolean;
  connected(): boolean;
  disconnect(): void;
  /** Which netcode-v2 tier this transport is — reported in the join so
   *  /metrics shows the real deployment's transport mix. */
  readonly tier?: TransportKind | 'p2p' | 'host';
  /** Worker transports run their own ping cadence — NetworkManager must
   *  not double-send app-level 'ping' probes. */
  readonly ownsPing?: boolean;
  /** Worker-side probes (clean wire RTT, postMessage delivery lag,
   *  receive-edge liveness stamp, coalesced tick count). */
  readonly probe?: { rttMs: number; lagMs: number; coalesced: number; lastRxAt: number; drainMsMax?: number };
}

export type TransportFactory = (config: ConnectionConfig) => GameTransport;
