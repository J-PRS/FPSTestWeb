import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import type { GameServer } from './GameServer.ts';

// node-datachannel is a native (N-API) module — Bun loads it through the
// node:module compatibility layer. If it ever fails to load, the whole
// import throws at module scope, so it's deferred behind a lazy dynamic
// import: the /rtcs endpoint just 503s instead of taking the server down.
type DataChannelLike = {
  sendMessage(msg: string): void;
  sendMessageBinary(msg: Uint8Array): void;
  onMessage(cb: (msg: string | Uint8Array) => void): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  isOpen(): boolean;
  close(): void;
};
type PeerConnectionLike = {
  onDataChannel(cb: (dc: DataChannelLike) => void): void;
  setRemoteDescription(sdp: string, type: string): void;
  setLocalDescription(type?: string): void;
  localDescription(): { sdp: string; type: string } | undefined;
  onGatheringStateChange(cb: (state: string) => void): void;
  close(): void;
};
type NdModule = { PeerConnection: new (name: string, cfg: { iceServers: string[] }) => PeerConnectionLike };

let ndc: NdModule | null = null;
let ndcFailed = false;
async function loadNd(): Promise<NdModule | null> {
  if (ndc || ndcFailed) return ndc;
  try {
    const mod = await import('node-datachannel');
    ndc = (mod.default ?? mod) as unknown as NdModule;
    logger.info('node-datachannel loaded — WebRTC tier live');
  } catch (e) {
    ndcFailed = true;
    logger.warn('node-datachannel unavailable — /rtcs disabled', { error: (e as Error).message });
  }
  return ndc;
}

/**
 * Minimal ServerWebSocket shape backed by an RTCDataChannel. GameServer
 * only ever touches send/close/readyState/data (+ remoteAddress in a debug
 * log), so an adapter is enough — the whole game pipeline (join handshake,
 * binary position frames, tick fanout) flows over SCTP without knowing it.
 */
class RtcSocketAdapter {
  readonly data: WebSocketData = { playerId: '', connectedAt: Date.now() };
  readonly remoteAddress = 'webrtc';
  constructor(private dc: DataChannelLike) {}
  get readyState(): number { return this.dc.isOpen() ? 1 : 3; }
  send(msg: string | Uint8Array): number {
    if (!this.dc.isOpen()) return 0;
    if (typeof msg === 'string') this.dc.sendMessage(msg);
    else this.dc.sendMessageBinary(new Uint8Array(msg));
    return typeof msg === 'string' ? msg.length : msg.byteLength;
  }
  close(code = 1000, reason = ''): void {
    logger.debug('RTC socket close', { code, reason });
    try { this.dc.close(); } catch { /* already gone */ }
  }
}

/**
 * Server-facing WebRTC endpoint. Signalling rides a plain WebSocket
 * (/rtcs): client sends {type:'offer', sdp}, we create the PeerConnection,
 * answer, and once the 'game' datachannel opens we hand an adapted socket
 * to GameServer — from there it's indistinguishable from /ws.
 *
 * Non-trickle ICE: the answer waits for gathering to complete so the SDP
 * embeds all candidates — one round trip, no candidate messages needed
 * for a server with a public/listening address.
 */
export class RtcServer {
  private signalSockets = new Set<ServerWebSocket<WebSocketData>>();
  private peers = new Map<ServerWebSocket<WebSocketData>, PeerConnectionLike>();
  private adapterOf = new Map<DataChannelLike, RtcSocketAdapter>();

  constructor(private game: GameServer) {}

  onOpen(ws: ServerWebSocket<WebSocketData>): void {
    this.signalSockets.add(ws);
    void loadNd().then((ok) => {
      if (!ok) ws.close(1013, 'rtc unavailable');
    });
  }

  onMessage(ws: ServerWebSocket<WebSocketData>, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;
    let m: { type?: string; sdp?: string };
    try { m = JSON.parse(message); } catch { return; }
    if (m.type !== 'offer' || typeof m.sdp !== 'string') return;
    void this.answerOffer(ws, m.sdp);
  }

  private async answerOffer(ws: ServerWebSocket<WebSocketData>, sdp: string): Promise<void> {
    const nd = await loadNd();
    if (!nd) { ws.close(1013, 'rtc unavailable'); return; }
    const pc = new nd.PeerConnection('srv', { iceServers: [] });
    this.peers.set(ws, pc);

    pc.onDataChannel((dc) => {
      const adapter = new RtcSocketAdapter(dc);
      this.adapterOf.set(dc, adapter);
      const sock = adapter as unknown as ServerWebSocket<WebSocketData>;
      dc.onOpen(() => this.game.onOpen(sock));
      dc.onMessage((msg) => this.game.onMessage(sock, msg instanceof Uint8Array ? msg : String(msg)));
      dc.onClosed(() => {
        this.adapterOf.delete(dc);
        this.game.onClose(sock);
      });
    });
    pc.onGatheringStateChange((state) => {
      if (state !== 'complete' || ws.readyState !== 1) return;
      const local = pc.localDescription();
      if (!local) return;
      // libdatachannel emits a=setup:actpass even in answers, which peers
      // (and libdatachannel itself) reject as illegal. 'active' makes us
      // the DTLS initiator — verified working against a loopback peer.
      const answerSdp = local.sdp.replace('a=setup:actpass', 'a=setup:active');
      ws.send(JSON.stringify({ type: 'answer', sdp: answerSdp }));
    });
    try {
      pc.setRemoteDescription(sdp, 'offer');
      // NB: must be the no-arg form — explicit 'answer' segfaults
      // libdatachannel on this platform (verified).
      pc.setLocalDescription();
    } catch (e) {
      // Malformed SDP (no ICE ufrag, truncated, etc.) — answer with a close
      // so the client's probe times out and falls back to the WS tier.
      logger.warn('RTC offer rejected', { error: (e as Error).message });
      this.peers.delete(ws);
      try { pc.close(); } catch { /* gone */ }
      ws.close(1008, 'bad offer');
    }
  }

  onClose(ws: ServerWebSocket<WebSocketData>): void {
    this.signalSockets.delete(ws);
    const pc = this.peers.get(ws);
    if (pc) {
      this.peers.delete(ws);
      try { pc.close(); } catch { /* gone */ }
    }
  }
}
