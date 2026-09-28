/**
 * Netcode v2 tier connect — tries transports best-first and hands back a
 * GameTransport. Order (see _docs/2026-09-26_netcode-v2.md):
 *
 *   WebTransport (QUIC datagrams) → WebRTC datachannel → WebSocket
 *
 * Today only the WebSocket tier is wired — the others stub to null until
 * their server halves exist (webtransport-bun / node-datachannel). The seam
 * is what matters: adding a tier means implementing `try*` and returning
 * early — callers and game code never change.
 */

import type { ConnectionConfig } from './WebSocketConnection.js';
import { WebSocketConnection } from './WebSocketConnection.js';
import type { GameTransport } from './transport.js';
import { ChildLogger } from '../core/Logger.js';
import { urlParams } from '../core/params.js';

const logger = new ChildLogger('NetTiers');

/** Opt-in knobs while the UDP tiers are stubbed: ?net=wt / ?net=rtc probe
 *  that tier before falling back; absent the param we go straight to WS. */
export async function connectGameTransport(config: ConnectionConfig): Promise<GameTransport> {
  const want = urlParams.net;
  if (want === 'wt') {
    const t = await tryWebTransport(config);
    if (t) return t;
    logger.warn('WebTransport unavailable — falling through');
  }
  if (want === 'wt' || want === 'rtc') {
    const t = await tryWebRTC(config);
    if (t) return t;
    logger.warn('WebRTC unavailable — falling through to WebSocket');
  }
  return new WebSocketConnection(config);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function tryWebTransport(_config: ConnectionConfig): Promise<GameTransport | null> {
  // Server side needs an HTTP/3 endpoint (webtransport-bun). Stubbed: probe
  // fails fast so the fallback fires; real impl arrives with the server half.
  if (typeof WebTransport === 'undefined') return null;
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function tryWebRTC(_config: ConnectionConfig): Promise<GameTransport | null> {
  // Needs the RtcRelay signal path + an unordered/unreliable DataChannel
  // wrapper. Stubbed for now — the P2P host path already proves the shape.
  if (typeof RTCPeerConnection === 'undefined') return null;
  return null;
}

/**
 * GameTransport that runs the tier probe on connect() and delegates to the
 * winner. NetworkManager's factory hook is synchronous, so the probe is
 * lazy: sends made before resolution queue briefly (the winner flushes
 * them right after its own connect — same guarantee WebSocketConnection
 * already gives for pre-open sends).
 */
export class TieredTransport implements GameTransport {
  private inner: GameTransport | null = null;
  private pending: (string | Uint8Array)[] = [];

  constructor(private readonly config: ConnectionConfig) {}

  connect(url?: string): void {
    void connectGameTransport(this.config).then((t) => {
      this.inner = t;
      t.connect(url);
      for (const d of this.pending) t.send(d);
      this.pending.length = 0;
    });
  }

  send(data: string | Uint8Array): boolean {
    if (this.inner) return this.inner.send(data);
    this.pending.push(data);
    return false;
  }

  sendUnreliable(data: string | Uint8Array): boolean {
    return this.inner?.sendUnreliable?.(data) ?? this.send(data);
  }

  connected(): boolean { return this.inner?.connected() ?? false; }
  disconnect(): void { this.inner?.disconnect(); }
}
