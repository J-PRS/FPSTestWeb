/**
 * Netcode v2 tier connect — tries transports best-first and hands back a
 * GameTransport. Order (see _docs/2026-09-26_netcode-v2.md):
 *
 *   WebTransport (QUIC datagrams) → WebRTC datachannel → WebSocket
 *
 * All three tiers are live. Probes run in parallel so the wait is the
 * slowest single probe (~3s cap), not the sum; WS needs no probe at all.
 * ?net=wt|rtc|ws pins one tier for testing; absent the param the best
 * available wins automatically.
 */

import type { ConnectionConfig } from './WebSocketConnection.js';
import { WebSocketConnection } from './WebSocketConnection.js';
import type { GameTransport } from './transport.js';
import { ChildLogger } from '../core/Logger.js';
import { tryWebTransport } from './tiersWebTransport.js';
import { urlParams } from '../core/params.js';

const logger = new ChildLogger('NetTiers');

/** Best-tier selection: ?net=wt|rtc|ws pins a single tier; otherwise WT and
 *  RTC probe in parallel and the better of whatever succeeded wins. WS is
 *  always the floor. */
/** A config whose callbacks stay muted until `arm()` — lets a probe lose
 *  the tier race and tear down silently instead of impersonating a drop
 *  of the winning session. */
function muteable(config: ConnectionConfig): { config: ConnectionConfig; arm(): void } {
  let armed = false;
  return {
    arm() { armed = true; },
    config: {
      ...config,
      onConnect: () => { if (armed) config.onConnect?.(); },
      onDisconnect: (c, r) => { if (armed) config.onDisconnect?.(c, r); },
      onError: (e) => { if (armed) config.onError?.(e); },
      onMessage: (m) => { if (armed) config.onMessage?.(m); },
      onBinaryMessage: (b) => { if (armed) config.onBinaryMessage?.(b); },
    },
  };
}

export async function connectGameTransport(config: ConnectionConfig): Promise<GameTransport> {
  const want = urlParams.net;
  if (want === 'ws') return new WebSocketConnection(config);
  if (want === 'wt') return (await tryWebTransport(config)) ?? new WebSocketConnection(config);
  if (want === 'rtc') return (await tryWebRTC(config)) ?? new WebSocketConnection(config);

  const now = Date.now();
  const probeWt = now >= missUntil.wt;
  const probeRtc = now >= missUntil.rtc;
  // Each candidate gets a muted wrapper — the tier probe disconnects the
  // losers, and without this a loser's teardown would fire onDisconnect/
  // onMessage as if the WINNING session dropped (or worse, deliver its
  // frames twice). Callbacks go live only for the transport that wins.
  const wtC = muteable(config);
  const rtcC = muteable(config);
  const [wt, rtc] = await Promise.all([
    probeWt ? tryWebTransport(wtC.config).catch(() => null) : null,
    probeRtc ? tryWebRTC(rtcC.config).catch(() => null) : null,
  ]);
  // Only an actual probe refreshes the miss window — a skipped probe must
  // not extend the cache or the tier never gets retried.
  if (probeWt && !wt) missUntil.wt = Date.now() + MISS_CACHE_MS;
  if (probeRtc && !rtc) missUntil.rtc = Date.now() + MISS_CACHE_MS;
  if (wt) { wtC.arm(); void rtc?.disconnect(); logger.info('tier: WebTransport'); return wt; }
  if (rtc) { rtcC.arm(); logger.info('tier: WebRTC'); return rtc; }
  logger.info('tier: WebSocket');
  return new WebSocketConnection(config);
}

// Negative tier cache — a failed WT probe leaves the QUIC session pending
// in Chrome (cap: 64 per profile). Retrying every reconnect tick exhausts
// it ("Too many pending WebTransport sessions") and the transport starts
// failing for unrelated reasons. Cache the miss for 30s.
const missUntil = { wt: 0, rtc: 0 };
const MISS_CACHE_MS = 30_000;

/**
 * WebRTC tier — client side. Opens a signaling WebSocket to the server's
 * rtc endpoint, exchanges SDP/ICE, then upgrades the game traffic to an
 * unordered+unreliable DataChannel (UDP semantics). Without a server-side
 * peer (node-datachannel) the offer never answers and we fall through.
 */
class ServerRtcTransport implements GameTransport {
  readonly tier = 'rtc' as const;
  private open = false;
  // `pc` is kept so a losing probe can be fully torn down — closing only
  // the datachannel leaves the ICE/DTLS machinery running server-side.
  constructor(
    private dc: RTCDataChannel,
    private config: ConnectionConfig,
    private pc?: RTCPeerConnection,
    // Reliable control channel for JSON events — the 'game' channel is
    // unordered+unreliable so join/claims sent over it could be lost.
    private ctrl?: RTCDataChannel,
  ) {
    dc.binaryType = 'arraybuffer';
    dc.addEventListener('message', (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) config.onBinaryMessage?.(new Uint8Array(data));
      else if (typeof data === 'string') {
        try { config.onMessage?.(JSON.parse(data)); } catch { /* malformed */ }
      }
    });
    dc.addEventListener('open', () => { this.open = true; config.onConnect?.(); });
    dc.addEventListener('close', () => { this.open = false; config.onDisconnect?.(1000, 'rtc closed'); });
    ctrl?.addEventListener('message', (ev) => {
      const data = ev.data;
      // Binary CAN arrive here — the server pushes ball segments down the
      // reliable lane, which is this channel on RTC. Dropping them was a
      // silent desync source.
      if (data instanceof ArrayBuffer) { config.onBinaryMessage?.(new Uint8Array(data)); return; }
      if (typeof data === 'string') {
        try { config.onMessage?.(JSON.parse(data)); } catch { /* malformed */ }
      }
    });
  }
  connect(): void {
    if (this.dc.readyState === 'open') {
      this.open = true;
      queueMicrotask(() => this.config.onConnect?.());
    }
  }
  send(data: string | Uint8Array): boolean {
    if (!this.open) return false;
    if (this.ctrl?.readyState === 'open') {
      if (typeof data === 'string') this.ctrl.send(data);
      else this.ctrl.send(new Uint8Array(data));
      return true;
    }
    if (this.dc.readyState !== 'open') return false;
    if (typeof data === 'string') this.dc.send(data);
    else this.dc.send(new Uint8Array(data));
    return true;
  }
  connected(): boolean { return this.open && this.dc.readyState === 'open'; }
  disconnect(): void {
    this.open = false;
    try { this.dc.close(); } catch { /* gone */ }
    try { this.pc?.close(); } catch { /* gone */ }
  }
}

async function tryWebRTC(config: ConnectionConfig): Promise<GameTransport | null> {
  if (typeof RTCPeerConnection === 'undefined') return null;
  let pc: RTCPeerConnection | undefined;
  let signalRef: WebSocket | undefined;
  try {
    // ICE servers come from the server itself (/rtcconfig) — STUN/TURN is a
    // deployment property, not a client constant; LAN/dev needs neither.
    const httpBase = config.url.replace(/^wss?:/, 'http' + (config.url.startsWith('wss') ? 's' : '') + ':').replace(/\/ws$/, '');
    const iceServers = await fetch(`${httpBase}/rtcconfig`)
      .then((r) => r.json())
      .then((j) => (Array.isArray(j?.iceServers) ? j.iceServers : []))
      .catch(() => []);
    pc = new RTCPeerConnection({ iceServers });
    const conn = pc;
    // 'game' used to be unordered+unreliable, but the lossy lane measured
    // ~33% drops and nothing calls sendUnreliable anymore — it's only the
    // fallback until 'ctrl' opens, so make it reliable too.
    const dc = conn.createDataChannel('game');
    const ctrl = conn.createDataChannel('ctrl'); // reliable+ordered — join, claims, events
    // Signal over the dedicated /rtcs socket — one offer in, one answer out.
    // The offer is sent only after ICE gathering completes so candidates
    // are embedded in the SDP (non-trickle — the server doesn't accept
    // trickle candidates; on LAN/host scenarios that's sufficient).
    const signal = new WebSocket(config.url.replace(/\/ws$/, '/rtcs'));
    signalRef = signal;
    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    if (conn.iceGatheringState !== 'complete') {
      await new Promise<void>((res) => {
        const t = setTimeout(res, 2500);
        conn.addEventListener('icegatheringstatechange', () => {
          if (conn.iceGatheringState === 'complete') { clearTimeout(t); res(); }
        });
      });
    }
    const sdp = conn.localDescription?.sdp ?? offer.sdp;
    const answer = await new Promise<RTCSessionDescriptionInit>((res, rej) => {
      // Server gathers its own ICE (STUN) before answering — that window
      // is seconds, so a LAN-era 3s timeout would always fall back to ws
      // for internet peers. 10s covers a slow srflx gather.
      const timer = setTimeout(() => rej(new Error('rtc signal timeout')), 10000);
      signal.addEventListener('message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'answer') { clearTimeout(timer); res(m); }
        } catch { /* not ours */ }
      });
      signal.addEventListener('error', () => rej(new Error('rtc signal error')));
      // The signal ws can already be OPEN here — it connected while we
      // were awaiting createOffer+ICE gather, so 'open' never refires and
      // the probe would sit out its 3s timeout. Send immediately when so.
      if (signal.readyState === WebSocket.OPEN) {
        signal.send(JSON.stringify({ type: 'offer', sdp }));
      } else {
        signal.addEventListener('open', () => signal.send(JSON.stringify({ type: 'offer', sdp })));
      }
    });
    await conn.setRemoteDescription(answer);
    signal.close();
    return new ServerRtcTransport(dc, config, conn, ctrl);
  } catch {
    // Failed probe — the ICE/DTLS machinery keeps running without this.
    try { pc?.close(); } catch { /* gone */ }
    // The signal ws leaks otherwise: closing while CONNECTING trips
    // Chrome's "closed before established" pageerror, so let it finish
    // opening and shut it then.
    const s = signalRef;
    if (s && s.readyState !== WebSocket.CLOSED && s.readyState !== WebSocket.CLOSING) {
      if (s.readyState === WebSocket.OPEN) s.close();
      else s.addEventListener('open', () => s.close(), { once: true });
    }
    return null;
  }
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
  private url: string | undefined;
  private closed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Connect-attempt epoch — losing-tier probes and stale reconnect timers
   *  fire callbacks too; only the CURRENT generation may re-arm a probe or
   *  claim the inner slot, or a loser's teardown orphans a live session
   *  (the connect storm: parallel sockets → "Player ID already connected"
   *  → new id minted → another orphan, ad infinitum). */
  private gen = 0;
  private static readonly BACKOFF_MS = 1000;

  constructor(private readonly config: ConnectionConfig) {}

  get tier() { return this.inner?.tier; }

  connect(url?: string): void {
    this.url = url;
    const gen = ++this.gen;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    // A previous inner can still be alive here (its teardown raced the
    // new attempt) — orphaning its socket is exactly the session leak
    // that floods the server with parallel joins.
    if (this.inner) { const old = this.inner; this.inner = null; old.disconnect(); }
    // Re-probe on each (re)connect: the previous best tier may be gone.
    // Inner transports see wrapped callbacks — a drop re-arms the probe
    // here, mirroring WebSocketConnection's own reconnect loop so a WT/RTC
    // session survives a blip instead of dying on first packet loss.
    const innerConfig: ConnectionConfig = {
      ...this.config,
      onDisconnect: (code, reason) => {
        // Stale generation — a losing probe's teardown or a superseded
        // attempt's timer. Forward nothing, schedule nothing.
        if (gen !== this.gen) return;
        this.config.onDisconnect?.(code, reason);
        if (this.closed) return;
        // WebSocketConnection runs its own reconnect loop — reprobing here
        // would double-schedule connections.
        if (this.inner instanceof WebSocketConnection) return;
        if (this.attempts < (this.config.maxReconnectAttempts ?? Infinity)) {
          this.attempts++;
          this.reconnectTimer = setTimeout(() => {
            if (!this.closed && this.gen === gen) this.connect(this.url);
          }, TieredTransport.BACKOFF_MS);
        }
      },
      onConnect: () => {
        if (gen !== this.gen) return;
        this.attempts = 0;
        this.config.onConnect?.();
      },
      onMessage: (data) => { if (gen === this.gen) this.config.onMessage?.(data); },
      onBinaryMessage: (data) => { if (gen === this.gen) this.config.onBinaryMessage?.(data); },
    };
    void connectGameTransport(innerConfig).then((t) => {
      if (this.closed || gen !== this.gen) { t.disconnect(); return; }
      this.inner = t;
      t.connect(url);
      for (const d of this.pending) t.send(d);
      this.pending.length = 0;
    }).catch((e) => {
      if (gen !== this.gen) return;
      this.config.onError?.(e instanceof Error ? e : new Error(String(e)));
    });
  }

  send(data: string | Uint8Array): boolean {
    if (this.inner) return this.inner.send(data);
    this.pending.push(data);
    return false;
  }

  connected(): boolean { return this.inner?.connected() ?? false; }
  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.inner?.disconnect();
  }
}
