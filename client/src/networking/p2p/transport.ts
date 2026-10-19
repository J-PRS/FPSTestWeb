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
  readonly tier = 'host' as const;
  private open = false;
  private link: P2PLink;

  constructor(private host: P2PHost, private config: ConnectionConfig) {
    this.link = {
      send: (data): void => this.deliver(data),
      close: (): void => { this.open = false; this.config.onDisconnect?.(1000, 'host closed'); },
    };
  }

  connect(): void {
    this.open = true;
    // onConnect must fire after the constructor returns — the caller's
    // NetworkManager isn't listening yet on the same tick.
    queueMicrotask((): void | undefined => this.config.onConnect?.());
  }

  send(data: string | Uint8Array): boolean {
    if (!this.open) {return false;}
    this.host.onData(this.link, data);
    return true;
  }

  private deliver(data: string | Uint8Array): void {
    if (typeof data === 'string') {
      try { this.config.onMessage?.(JSON.parse(data)); } catch (error) { logger.error('loopback parse', error); }
    } else {
      this.config.onBinaryMessage?.(data);
    }
  }

  connected(): boolean { return this.open; }
  disconnect(): void { this.open = false; this.host.onClose(this.link); }
}

/** Guest-side: frames ride the two RTCDataChannel lanes to the host's
 *  browser — binary on 'game' (unordered/bounded-retransmit), JSON on
 *  'ctrl' (reliable+ordered), same split the dedicated RTC lanes use. */
export class DataChannelTransport implements GameTransport {
  readonly tier = 'p2p' as const;
  private open = false;

  constructor(private chans: { game: RTCDataChannel; ctrl: RTCDataChannel; pc: RTCPeerConnection | null }, private config: ConnectionConfig) {
    const { pc } = chans;
    // ICE watchdog, same verdict the dedicated-RTC lane uses: SCTP teardown
    // doesn't reliably fire datachannel 'close', so a silently-dead
    // association would hang the session until the stall watchdog notices.
    // 'disconnected' gets a grace window — it often recovers on its own.
    pc?.addEventListener('iceconnectionstatechange', (): void => {
      const s = pc.iceConnectionState;
      logger.warn(`p2p ice: ${s}`);
      if (s === 'failed' || s === 'closed') {
        this.disconnect();
        this.config.onDisconnect?.(1000, `ice ${s}`);
      } else if (s === 'disconnected') {
        setTimeout((): void => {
          const now = pc.iceConnectionState;
          if (now === 'disconnected' || now === 'failed') {
            this.disconnect();
            this.config.onDisconnect?.(1000, `ice ${now}`);
          }
        }, 2500);
      }
    });
    for (const dc of [chans.game, chans.ctrl]) {
      dc.binaryType = 'arraybuffer';
      dc.addEventListener('message', (ev): void => {
        const {data} = ev;
        if (typeof data === 'string') {
          try { this.config.onMessage?.(JSON.parse(data)); } catch (error) { logger.error('dc parse', error); }
        } else if (data instanceof ArrayBuffer) {
          this.config.onBinaryMessage?.(new Uint8Array(data));
        }
      });
      // Connected only once both lanes report open — a half-up pair would
      // blackhole whichever traffic class hasn't arrived yet.
      dc.addEventListener('open', (): void => {
        if (chans.game.readyState === 'open' && chans.ctrl.readyState === 'open' && !this.open) {
          this.open = true;
          this.config.onConnect?.();
        }
      });
      // A lane dying kills the session — a half-dead pair misroutes.
      dc.addEventListener('close', (): void => { this.open = false; this.config.onDisconnect?.(1000, 'peer closed'); });
    }
  }

  connect(): void {
    // The channels may already be open by the time we're constructed.
    if (this.chans.game.readyState === 'open' && this.chans.ctrl.readyState === 'open') {
      this.open = true;
      queueMicrotask((): void | undefined => this.config.onConnect?.());
    }
  }

  private lane(data: string | Uint8Array): RTCDataChannel | null {
    const want = typeof data === 'string' ? this.chans.ctrl : this.chans.game;
    const alt = typeof data === 'string' ? this.chans.game : this.chans.ctrl;
    return want.readyState === 'open' ? want : alt.readyState === 'open' ? alt : null;
  }

  send(data: string | Uint8Array): boolean {
    if (!this.open) {return false;}
    const dc = this.lane(data);
    if (!dc) {return false;}
    if (typeof data === 'string') {dc.send(data);}
    else {dc.send(new Uint8Array(data));}
    return true;
  }

  connected(): boolean { return this.open && this.lane('') !== null; }
  disconnect(): void {
    this.open = false;
    for (const dc of [this.chans.game, this.chans.ctrl]) {try { dc.close(); } catch { /* already gone */ }}
    // Closing only the channels leaves ICE/DTLS machinery running.
    try { this.chans.pc?.close(); } catch { /* already gone */ }
  }
}
