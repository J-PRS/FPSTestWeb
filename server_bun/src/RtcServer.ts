import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';
import type { GameServer } from './GameServer.ts';
import { WIRE_TICK } from '../../shared/wire.ts';
import { wallNow } from './wallClock.ts';

// node-datachannel's IceServer record is {hostname, port, relayer?}, not
// the {urls:...} objects the browser API uses — translate FPS_ICE_SERVERS
// once at import. An empty list = host candidates only, fine for LAN dev
// but no srflx gathering — internet friends need STUN here to punch NAT.
// (TURN creds aren't expressible in this record shape; a relay deploy
// needs the env extended anyway.)
function serverIce(): { hostname: string; port: number; relayer?: boolean }[] {
  try {
    const raw = CONFIG.iceServersJson ? JSON.parse(CONFIG.iceServersJson) : [];
    if (!Array.isArray(raw)) return [];
    const out: { hostname: string; port: number; relayer?: boolean }[] = [];
    for (const e of raw) {
      const urls = typeof e === 'string' ? [e] : (Array.isArray(e?.urls) ? e.urls : (e?.urls ? [e.urls] : []));
      for (const u of urls) {
        const m = typeof u === 'string' && u.match(/^(stun|turn)s?:\/\/([^:/]+):?(\d+)?/);
        if (m) out.push({ hostname: m[2]!, port: m[3] ? +m[3] : 3478, relayer: m[1]!.startsWith('turn') });
      }
    }
    return out;
  } catch { return []; }
}
const SERVER_ICE = serverIce();

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
  bufferedAmount?(): number;
};
type PeerConnectionLike = {
  onDataChannel(cb: (dc: DataChannelLike) => void): void;
  setRemoteDescription(sdp: string, type: string): void;
  setLocalDescription(type?: string): void;
  localDescription(): { sdp: string; type: string } | undefined;
  onGatheringStateChange(cb: (state: string) => void): void;
  close(): void;
};
type NdModule = { PeerConnection: new (name: string, cfg: { iceServers: { hostname: string; port: number; relayer?: boolean }[] }) => PeerConnectionLike };

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
  readonly data: WebSocketData = { playerId: '', connectedAt: wallNow() };
  // The datachannel has no IP, but its signalling ws did — inherit it so
  // per-IP flood control (join throttle) attributes correctly. Sharing the
  // literal 'webrtc' made EVERY RTC client share one throttle bucket.
  constructor(readonly remoteAddress: string) {}
  // Two lanes per peer: 'game' (unordered, bounded retransmit) carries
  // the volatile seq'd streams — WIRE_TICK down, position up — that the
  // receiver stale-drops anyway; 'ctrl' (ordered/reliable) carries JSON
  // and WIRE_BALLSEG, which must arrive. Routing by wire type keeps the
  // split invisible to GameServer.
  private game: DataChannelLike | null = null;
  private ctrl: DataChannelLike | null = null;

  attach(dc: DataChannelLabeled): void {
    const label = dc.getLabel?.() ?? dc.label;
    if (label === 'ctrl') this.ctrl = dc;
    else this.game = dc; // 'game' or unlabeled → the fast lane
  }
  get readyState(): number { return this.game?.isOpen() || this.ctrl?.isOpen() ? 1 : 3; }
  getBufferedAmount(): number { return (this.ctrl ?? this.game)?.bufferedAmount?.() ?? 0; }
  send(msg: string | Uint8Array): number {
    // Lane route: tick frames (WIRE_TICK) are seq'd volatile state → game;
    // strings and everything else (ball segments) must arrive → ctrl.
    // Each lane falls back to the other when closed so a lane that isn't
    // up yet can't blackhole traffic.
    const fast = typeof msg !== 'string' && msg[0] === 0x54 && msg[1] === WIRE_TICK;
    const lane = fast ? this.game : this.ctrl;
    const alt = fast ? this.ctrl : this.game;
    const dc = lane?.isOpen() ? lane : alt?.isOpen() ? alt : null;
    if (!dc) return 0;
    // isOpen() can lag the real channel state on close races; a failed
    // send must not take down the whole broadcast path.
    try {
      if (typeof msg === 'string') dc.sendMessage(msg);
      else dc.sendMessageBinary(new Uint8Array(msg));
    } catch { return 0; }
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

    const adapter = new RtcSocketAdapter(ws.remoteAddress);
    const sock = adapter as unknown as ServerWebSocket<WebSocketData>;
    let opened = false;
    let closedOnce = false;
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
        // Two channels (game/ctrl) die together — only the first close
        // runs the grace path, else every RTC player logs disconnect twice.
        if (adapter.readyState !== 1 && !closedOnce) {
          closedOnce = true;
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
