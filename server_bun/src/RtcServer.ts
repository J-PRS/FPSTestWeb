import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import type { GameServer } from './GameServer.ts';

// libdatachannel takes flat URL strings, not the RTCIceServer objects the
// browser API uses — translate FPS_ICE_SERVERS once at import: entries may
// be "stun:host:port" strings or {urls,username,credential} objects. An
// empty list = host candidates only, fine for LAN/tunnel-less dev but no
// srflx gathering — internet friends need STUN here to punch NAT.
function serverIceUrls(): string[] {
  try {
    const raw = CONFIG.iceServersJson ? JSON.parse(CONFIG.iceServersJson) : [];
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const e of raw) {
      if (typeof e === 'string') { out.push(e); continue; }
      const urls = Array.isArray(e?.urls) ? e.urls : (e?.urls ? [e.urls] : []);
      for (const u of urls) {
        if (typeof u !== 'string') continue;
        // TURN needs auth baked into the URL: turn:user:pass@host
        if (u.startsWith('turn') && (e.username || e.credential)) {
          const m = u.match(/^(turns?:)(.*)$/);
          if (m) out.push(`${m[1]}${e.username ?? ''}:${e.credential ?? ''}@${m[2]}`);
        } else out.push(u);
      }
    }
    return out;
  } catch { return []; }
}
const SERVER_ICE = serverIceUrls();

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
type DataChannelLabeled = DataChannelLike & { getLabel?(): string; label?: string };

class RtcSocketAdapter {
  readonly data: WebSocketData = { playerId: '', connectedAt: Date.now() };
  readonly remoteAddress = 'webrtc';
  // Two lanes per peer: 'game' (unordered/unreliable — ticks, positions)
  // and 'ctrl' (ordered/reliable — join, claims, events). Reliable traffic
  // on the lossy channel would silently drop a join; unreliable on ctrl
  // would retransmit stale frames, so the lanes must not share.
  private game: DataChannelLike | null = null;
  private ctrl: DataChannelLike | null = null;

  attach(dc: DataChannelLabeled): void {
    const label = dc.getLabel?.() ?? dc.label;
    if (label === 'ctrl') this.ctrl = dc;
    else this.game = dc; // 'game' or unlabeled → the fast lane
  }
  get readyState(): number { return this.game?.isOpen() || this.ctrl?.isOpen() ? 1 : 3; }
  send(msg: string | Uint8Array): number {
    const dc = this.ctrl ?? this.game;
    if (!dc?.isOpen()) return 0;
    if (typeof msg === 'string') dc.sendMessage(msg);
    else dc.sendMessageBinary(new Uint8Array(msg));
    return typeof msg === 'string' ? msg.length : msg.byteLength;
  }
  sendUnreliable(msg: string | Uint8Array): number {
    const dc = this.game ?? this.ctrl;
    if (!dc?.isOpen()) return 0;
    if (typeof msg === 'string') dc.sendMessage(msg);
    else dc.sendMessageBinary(new Uint8Array(msg));
    return typeof msg === 'string' ? msg.length : msg.byteLength;
  }
  close(code = 1000, reason = ''): void {
    logger.debug('RTC socket close', { code, reason });
    try { this.game?.close(); } catch { /* already gone */ }
    try { this.ctrl?.close(); } catch { /* already gone */ }
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
  // Signal sockets close right after the answer (browser + headless both
  // do this) — track which signal ws already have a live datachannel so
  // onClose doesn't kill a session that successfully negotiated.
  private livePeers = new Set<ServerWebSocket<WebSocketData>>();

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
    // Each offer spawns a native PeerConnection — cap in-flight ones.
    if (this.peers.size >= 64) { ws.close(1013, 'rtc busy'); return; }
    void this.answerOffer(ws, m.sdp);
  }

  private async answerOffer(ws: ServerWebSocket<WebSocketData>, sdp: string): Promise<void> {
    const nd = await loadNd();
    if (!nd) { ws.close(1013, 'rtc unavailable'); return; }
    // Same ICE list the client gets via /rtcconfig — without STUN here the
    // server only emits LAN host candidates, unreachable across the internet.
    const pc = new nd.PeerConnection('srv', { iceServers: SERVER_ICE });
    this.peers.set(ws, pc);

    const adapter = new RtcSocketAdapter();
    const sock = adapter as unknown as ServerWebSocket<WebSocketData>;
    let opened = false;
    // Half-open peer guard: if signaling finished but no datachannel
    // arrives (client vanished mid-handshake), don't hold the PC forever.
    const staleTimer = setTimeout(() => {
      if (!opened) {
        this.peers.delete(ws);
        try { pc.close(); } catch { /* gone */ }
      }
    }, 30_000);
    pc.onDataChannel((dc) => {
      adapter.attach(dc as DataChannelLabeled);
      this.adapterOf.set(dc, adapter);
      dc.onMessage((msg) => this.game.onMessage(sock, msg instanceof Uint8Array ? msg : String(msg)));
      dc.onOpen(() => {
        // game.onOpen once — whichever channel opens first starts the session
        if (!opened) { opened = true; clearTimeout(staleTimer); this.livePeers.add(ws); this.game.onOpen(sock); }
      });
      dc.onClosed(() => {
        this.adapterOf.delete(dc);
        if (adapter.readyState !== 1) {
          this.game.onClose(sock);
          this.livePeers.delete(ws);
          this.peers.delete(ws);
          try { pc.close(); } catch { /* gone */ }
        }
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
      clearTimeout(staleTimer);
      this.peers.delete(ws);
      try { pc.close(); } catch { /* gone */ }
      ws.close(1008, 'bad offer');
    }
  }

  onClose(ws: ServerWebSocket<WebSocketData>): void {
    this.signalSockets.delete(ws);
    // Signaling is one-shot: clients close it right after the answer —
    // long BEFORE the datachannel opens. Never close the pc here: the
    // stale-peer timer reaps never-opened peers, dc.onClosed reaps the
    // rest. peers.delete keeps the in-flight-offer cap honest.
    this.peers.delete(ws);
  }

  /** Cap how many un-answered offers can pile up — each holds a PC. */
  get pendingPeers(): number { return this.peers.size; }
}
