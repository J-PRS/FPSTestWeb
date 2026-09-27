/**
 * P2P transports — both quack like WebSocketConnection so NetworkManager
 * can sit on top unchanged.
 *
 * LoopbackTransport: the HOST's own client → straight into P2PHost.
 * DataChannelTransport: the GUEST's client → over the RTCDataChannel.
 */

import type { ConnectionConfig } from '../WebSocketConnection.js';
import type { GameTransport } from '../transport.js';
import type { P2PHost, P2PLink } from './host.js';
import { ChildLogger } from '../../core/Logger.js';

const logger = new ChildLogger('P2P');

/** Host-side: the local client's "socket" is a function call. */
export class LoopbackTransport implements GameTransport {
  private open = false;
  private link: P2PLink;

  constructor(private host: P2PHost, private config: ConnectionConfig) {
    this.link = {
      send: (data) => this.deliver(data),
      close: () => { this.open = false; this.config.onDisconnect?.(1000, 'host closed'); },
    };
  }

  connect(): void {
    this.open = true;
    // onConnect must fire after the constructor returns — the caller's
    // NetworkManager isn't listening yet on the same tick.
    queueMicrotask(() => this.config.onConnect?.());
  }

  send(data: string | Uint8Array): boolean {
    if (!this.open) return false;
    this.host.onData(this.link, data);
    return true;
  }

  private deliver(data: string | Uint8Array): void {
    if (typeof data === 'string') {
      try { this.config.onMessage?.(JSON.parse(data)); } catch (e) { logger.error('loopback parse', e); }
    } else {
      this.config.onBinaryMessage?.(data);
    }
  }

  connected(): boolean { return this.open; }
  disconnect(): void { this.open = false; this.host.onClose(this.link); }
}

/** Guest-side: frames ride the RTCDataChannel to the host's browser. */
export class DataChannelTransport implements GameTransport {
  private open = false;

  constructor(private dc: RTCDataChannel, private config: ConnectionConfig) {
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        try { this.config.onMessage?.(JSON.parse(data)); } catch (e) { logger.error('dc parse', e); }
      } else if (data instanceof ArrayBuffer) {
        this.config.onBinaryMessage?.(new Uint8Array(data));
      }
    };
    dc.onopen = () => { this.open = true; this.config.onConnect?.(); };
    dc.onclose = () => { this.open = false; this.config.onDisconnect?.(1000, 'peer closed'); };
  }

  connect(): void {
    // The channel may already be open by the time we're constructed.
    if (this.dc.readyState === 'open') {
      this.open = true;
      queueMicrotask(() => this.config.onConnect?.());
    }
  }

  send(data: string | Uint8Array): boolean {
    if (!this.open || this.dc.readyState !== 'open') return false;
    if (typeof data === 'string') this.dc.send(data);
    else this.dc.send(new Uint8Array(data));
    return true;
  }

  connected(): boolean { return this.open && this.dc.readyState === 'open'; }
  disconnect(): void { this.open = false; try { this.dc.close(); } catch { /* already gone */ } }
}
