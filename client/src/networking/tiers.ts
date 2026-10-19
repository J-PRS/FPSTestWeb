/**
 * Netcode v2 tier connect — tries transports best-first and hands back a
 * GameTransport. Order (see _docs/2026-09-26_netcode-v2.md):
 *
 *   WebTransport (QUIC datagrams) → WebRTC datachannel → WebSocket
 *
 * All three tiers are live. The ladder is the default: with no ?net the
 * WT/RTC probes run in parallel and the winner serves, WS underneath.
 * ?net=wt|rtc|ws pins one tier for testing.
 */

import {type ConnectionConfig, WebSocketConnection} from './WebSocketConnection.js';
import type { GameTransport } from './transport.js';
import type { ServerMessage } from '../../../shared/protocol.js';
import { netLogger } from './netLog.js';
import { tryWebTransport } from './tiersWebTransport.js';
// failing for unrelated reasons. Cache the miss for 30s.
const MISS_CACHE_MS = 30_000;

const logger = netLogger('NetTiers');

/** Tier pin — the net worker can't read ?net off window.location, so the
 *  caller (WorkerTransport init / page code) passes it down. */
export interface TierOpts { net?: string }

/** Best-tier selection: ?net=wt|rtc|ws pins a single tier; otherwise WT and
 *  RTC probe in parallel and the better of whatever succeeded wins. WS is
 *  always the floor. */
/** A config whose callbacks stay muted until `arm()` — lets a probe lose
 *  the tier race and tear down silently instead of impersonating a drop
 *  of the winning session. */
function muteable(config: ConnectionConfig): { config: ConnectionConfig; arm(): void } {
  let armed = false;
  const wrapped: Partial<ConnectionConfig> = {
    onConnect: (): void => { if (armed) {config.onConnect?.();} },
    onDisconnect: (c, r): void => { if (armed) {config.onDisconnect?.(c, r);} },
    onError: (e): void => { if (armed) {config.onError?.(e);} },
    onMessage: (m): void => { if (armed) {config.onMessage?.(m);} },
    onBinaryMessage: (b): void => { if (armed) {config.onBinaryMessage?.(b);} },
  };
  return {
    arm(): void { armed = true; },
    config: Object.assign({}, config, wrapped),
  };
}

async function tryWebRTC(config: ConnectionConfig): Promise<GameTransport | null> {
  if (typeof RTCPeerConnection === 'undefined') {return null;}
  let pc: RTCPeerConnection | undefined = undefined;
  let signalRef: WebSocket | undefined = undefined;
  try {
    // ICE servers come from the server itself (/rtcconfig) — STUN/TURN is a
    // deployment property, not a client constant; LAN/dev needs neither.
    const httpBase = config.url.replace(/^wss?:/, `http${  config.url.startsWith('wss') ? 's' : ''  }:`).replace(/\/ws$/, '');
    const iceServers = await fetch(`${httpBase}/rtcconfig`, { signal: AbortSignal.timeout(4000) })
      .then((r): Promise<{ iceServers?: RTCIceServer[] }> => r.json())
      .then((j): RTCIceServer[] => (Array.isArray(j?.iceServers) ? j.iceServers : []))
      .catch((): never[] => []);
    pc = new RTCPeerConnection({ iceServers });
    const conn = pc;
    // Lane split: 'game' is unordered with bounded retransmits — it carries
    // only seq-stamped volatile frames (position up, tickUpdate down) that
    // the receiver stale-drops anyway, so a lost/superseded packet must not
    // stall the SCTP association. maxRetransmits:2 covers jitter spikes
    // without ever head-of-line blocking behind a superseded seq.
    const dc = conn.createDataChannel('game', { ordered: false, maxRetransmits: 2 });
    const ctrl = conn.createDataChannel('ctrl'); // reliable+ordered — join, claims, events, ball segments
    // Signal over the dedicated /rtcs socket — one offer in, one answer out.
    // The offer is sent only after ICE gathering completes so candidates
    // are embedded in the SDP (non-trickle — the server doesn't accept
    // trickle candidates; on LAN/host scenarios that's sufficient).
    const signal = new WebSocket(config.url.replace(/\/ws$/, '/rtcs'));
    signalRef = signal;
    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    if (conn.iceGatheringState !== 'complete') {
      await new Promise<void>((res): void => {
        const t = setTimeout(res, 2500);
        conn.addEventListener('icegatheringstatechange', (): void => {
          if (conn.iceGatheringState === 'complete') { clearTimeout(t); res(); }
        });
      });
    }
    const sdp = conn.localDescription?.sdp ?? offer.sdp;
    const answer = await new Promise<RTCSessionDescriptionInit>((res, rej): void => {
      // Server gathers its own ICE (STUN) before answering — that window
      // is seconds, so a LAN-era 3s timeout would always fall back to ws
      // for internet peers. 10s covers a slow srflx gather.
      const timer = setTimeout((): void => rej(new Error('rtc signal timeout')), 10_000);
      signal.addEventListener('message', (ev): void => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'answer') { clearTimeout(timer); res(m); }
        } catch { /* not ours */ }
      });
      signal.addEventListener('error', (): void => rej(new Error('rtc signal error')));
      // The signal ws can already be OPEN here — it connected while we
      // were awaiting createOffer+ICE gather, so 'open' never refires and
      // the probe would sit out its 3s timeout. Send immediately when so.
      if (signal.readyState === WebSocket.OPEN) {
        signal.send(JSON.stringify({ type: 'offer', sdp }));
      } else {
        signal.addEventListener('open', (): void => signal.send(JSON.stringify({ type: 'offer', sdp })));
      }
    });
    await conn.setRemoteDescription(answer);
    signal.close();
    // ICE diagnostics/watchdog live on the transport — it can declare the
    // session dead directly instead of hoping channel 'close' events fire.
    // oxlint-disable-next-line no-use-before-define -- class declared below; only instantiated at call time
    return new ServerRtcTransport(dc, config, conn, ctrl);
  } catch {
    // Failed probe — the ICE/DTLS machinery keeps running without this.
    try { pc?.close(); } catch { /* gone */ }
    // The signal ws leaks otherwise: closing while CONNECTING trips
    // Chrome's "closed before established" pageerror, so let it finish
    // opening and shut it then.
    const s = signalRef;
    if (s && s.readyState !== WebSocket.CLOSED && s.readyState !== WebSocket.CLOSING) {
      if (s.readyState === WebSocket.OPEN) {s.close();}
      else {s.addEventListener('open', (): void => s.close(), { once: true });}
    }
    return null;
  }
}



/** ?net=ws|wt|rtc pins a single tier for testing. The raced probes were
 *  the session layer's bug source once — muteable/gen/flap-breaker/miss-
 *  cache now hold that fault line, so the ladder is the default again. */
async function pinnedTier(want: string | null | undefined, config: ConnectionConfig): Promise<GameTransport> {
  if (want === 'wt') {return (await tryWebTransport(config)) ?? new WebSocketConnection(config);}
  if (want === 'rtc') {return (await tryWebRTC(config)) ?? new WebSocketConnection(config);}
  logger.info('tier: WebSocket');
  return new WebSocketConnection(config);
}



export async function connectGameTransport(config: ConnectionConfig, opts?: TierOpts): Promise<GameTransport> {
  const want = opts?.net ?? 'auto';
  if (want !== 'auto') {return pinnedTier(want, config);}
  const now = Date.now();
  const probeWt = now >= missUntil.wt;
  const probeRtc = now >= missUntil.rtc;
  // Each candidate gets a muted wrapper — the tier probe disconnects the
  // losers, and without this a loser's teardown would fire onDisconnect/
  // onMessage as if the WINNING session dropped (or worse, deliver its
  // frames twice). Callbacks go live only for the transport that wins.
  const wtC = muteable(config);
  const rtcC = muteable(config);
  // Hard cap per probe — a dead/slow tier (non-QUIC origin, empty ICE
  // config, filterbox) must not starve the ws floor. Measured: a
  // trycloudflare-origin connect spent ~30s probing before the known-good
  // lane ever opened. A late-resolving probe is orphaned with a muted
  // config: dispose it or it sits as a zombie lane holding a seat.
  let capExpired = false;
  const capped = (p: Promise<GameTransport | null>): Promise<GameTransport | null> => {
    const guarded = p.then((t): GameTransport | null => { if (capExpired) { t?.disconnect(); return null; } return t; });
    return Promise.race([guarded, new Promise<null>((res): void => { setTimeout((): void => res(null), 4000); })]);
  };
  const [wt, rtc] = await Promise.all([
    probeWt ? capped(tryWebTransport(wtC.config).catch((): null => null)) : null,
    probeRtc ? capped(tryWebRTC(rtcC.config).catch((): null => null)) : null,
  ]);
  capExpired = true;
  // Only an actual probe refreshes the miss window — a skipped probe must
  // not extend the cache or the tier never gets retried.
  if (probeWt && !wt) {missUntil.wt = Date.now() + MISS_CACHE_MS;}
  if (probeRtc && !rtc) {missUntil.rtc = Date.now() + MISS_CACHE_MS;}
  if (wt) { wtC.arm(); rtc?.disconnect(); logger.info('tier: WebTransport'); return wt; }
  if (rtc) { rtcC.arm(); logger.info('tier: WebRTC'); return rtc; }
  logger.info('tier: WebSocket');
  return new WebSocketConnection(config);
}

// Negative tier cache — a failed WT probe leaves the QUIC session pending
// in Chrome (cap: 64 per profile). Retrying every reconnect tick exhausts
// QUIC cap ("Too many pending WebTransport sessions") and the transport starts
const missUntil = { wt: 0, rtc: 0 };

/**
 * WebRTC tier — client side. Opens a signaling WebSocket to the server's
 * rtc endpoint, exchanges SDP/ICE, then runs two lanes: 'game' (unordered,
 * bounded retransmit — volatile seq'd binary) and 'ctrl' (reliable+ordered —
 * JSON, ball segments). Without a server-side peer (node-datachannel) the
 * offer never answers and we fall through.
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
    // Reliable control channel for JSON + ball segments — 'game' is
    // unordered/bounded-loss so anything that must arrive rides ctrl.
    private ctrl?: RTCDataChannel,
  ) {
    dc.binaryType = 'arraybuffer';
    dc.addEventListener('message', (ev): void => {
      const {data} = ev;
      if (data instanceof ArrayBuffer) {config.onBinaryMessage?.(new Uint8Array(data));}
      else if (typeof data === 'string') {
        try { config.onMessage?.(JSON.parse(data)); } catch { /* malformed */ }
      }
    });
    dc.addEventListener('open', (): void => { this.open = true; config.onConnect?.(); });
    // Two lanes share one SCTP association — the server counts the seat
    // live while EITHER is open (RtcSocketAdapter.readyState), so a
    // single-lane close must not flap the whole session. Only declare
    // disconnect when nothing is left to talk on.
    dc.addEventListener('close', (): void => this.checkDead('game'));
    ctrl?.addEventListener('close', (): void => this.checkDead('ctrl'));
    // ICE watchdog lives here (was in tryWebRTC): it calls declareDead
    // directly, so a dead association reconnects even if the datachannel
    // 'close' events never dispatch — 'disconnected' is a grace state
    // that often recovers; 'failed'/'closed' are terminal.
    pc?.addEventListener('iceconnectionstatechange', (): void => {
      logger.warn(`rtc ice: ${pc.iceConnectionState}`);
      const s = pc.iceConnectionState;
      if (s === 'failed' || s === 'closed') {
        this.killLanes(`ice ${s}`);
      } else if (s === 'disconnected') {
        setTimeout((): void => {
          const now = pc.iceConnectionState;
          if (now === 'disconnected' || now === 'failed') {this.killLanes(`ice ${now}`);}
        }, 2500);
      }
    });
    ctrl?.addEventListener('message', (ev): void => {
      const {data} = ev;
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
      queueMicrotask((): void | undefined => this.config.onConnect?.());
    }
  }
  send(data: string | Uint8Array): boolean {
    if (!this.open) {return false;}
    // Last-ditch detector: if neither lane is open the pipe is dead —
    // declare it so a silent SCTP teardown still triggers the reconnect,
    // even if neither 'close' nor an ICE transition ever fired.
    if (this.dc.readyState !== 'open' && this.ctrl?.readyState !== 'open') {
      this.declareDead('rtc lanes dead (send probe)');
      return false;
    }
    // Lane route: strings (JSON claims/events) → reliable ctrl; binary
    // (seq'd position frames) → lossy game. Whichever lane is asked for
    // falls back to the other when closed — a lane that isn't up yet
    // must not blackhole traffic.
    const binary = typeof data !== 'string';
    const lane = binary ? this.dc : this.ctrl;
    const alt = binary ? this.ctrl : this.dc;
    let dc = null;
    if (lane?.readyState === 'open') {dc = lane;}
    else if (alt?.readyState === 'open') {dc = alt;}
    if (!dc) {return false;}
    if (typeof data === 'string') {dc.send(data);}
    else {dc.send(new Uint8Array(data));}
    return true;
  }
  private dead = false;
  /** The single disconnect declaration — lane-close events AND the ICE
   *  watchdog both land here so either detection path reconnects. */
  private declareDead(reason: string): void {
    if (this.dead) {return;}
    this.dead = true;
    this.open = false;
    this.config.onDisconnect?.(1000, reason);
  }
  private checkDead(lane: 'game' | 'ctrl'): void {
    // A lane 'close' event can precede its readyState flip — check both.
    const gameOpen = this.dc.readyState === 'open';
    const ctrlOpen = this.ctrl?.readyState === 'open';
    if (gameOpen || ctrlOpen) {return;}
    this.declareDead(`rtc closed (${lane} last)`);
  }
  /** ICE verdict is the authority — SCTP teardown doesn't reliably fire
   *  datachannel 'close', which left dead lanes reporting half-open and
   *  the reconnect probe never armed. */
  private killLanes(reason: string): void {
    try { this.dc.close(); } catch { /* gone */ }
    try { this.ctrl?.close(); } catch { /* gone */ }
    this.declareDead(reason);
  }
  connected(): boolean {
    return this.open && (this.dc.readyState === 'open' || this.ctrl?.readyState === 'open');
  }
  disconnect(): void {
    this.open = false;
    this.dead = true; // muted/losing-probe teardown must not declare dead
    try { this.dc.close(); } catch { /* gone */ }
    try { this.pc?.close(); } catch { /* gone */ }
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
  private connectedAt = 0;
  /** Connect-attempt epoch — losing-tier probes and stale reconnect timers
   *  fire callbacks too; only the CURRENT generation may re-arm a probe or
   *  claim the inner slot, or a loser's teardown orphans a live session
   *  (the connect storm: parallel sockets → "Player ID already connected"
   *  → new id minted → another orphan, ad infinitum). */
  private gen = 0;
  private static readonly BACKOFF_MS = 1000;

  constructor(private readonly config: ConnectionConfig, private readonly opts?: TierOpts) {}

  get tier() { return this.inner?.tier; }

  connect(url?: string): void {
    this.url = url;
    this.gen += 1;
    const {gen} = this;
    this.closed = false;
    // Sends queued during a superseded attempt belong to that generation —
    // flushing them into the new probe could replay a stale join.
    this.pending.length = 0;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    // A previous inner can still be alive here (its teardown raced the
    // new attempt) — orphaning its socket is exactly the session leak
    // that floods the server with parallel joins.
    if (this.inner) { const old = this.inner; this.inner = null; old.disconnect(); }
    // Re-probe on each (re)connect: the previous best tier may be gone.
    // Inner transports see wrapped callbacks — a drop re-arms the probe
    // here, mirroring WebSocketConnection's own reconnect loop so a WT/RTC
    // session survives a blip instead of dying on first packet loss.
    const innerConfig: ConnectionConfig = Object.assign({}, this.config, {onDisconnect: (code?: number, reason?: string): void => {
        // Stale generation — a losing probe's teardown or a superseded
        // attempt's timer. Forward nothing, schedule nothing.
        if (gen !== this.gen) {return;}
        this.config.onDisconnect?.(code, reason);
        if (this.closed) {return;}
        // Flap breaker: a tier that dies seconds after connecting is worse
        // than not having it — mark the miss so the re-probe skips it and
        // the session lands on WS instead of connect/disconnect looping.
        const flapTier = this.inner?.tier;
        if ((flapTier === 'rtc' || flapTier === 'wt') && Date.now() - this.connectedAt < 10_000) {
          missUntil[flapTier] = Date.now() + MISS_CACHE_MS;
          logger.warn(`${flapTier} session flapped — tier benched for 30s`, { code, reason });
        }
        // WebSocketConnection runs its own reconnect loop — reprobing here
        // would double-schedule connections.
        if (this.inner instanceof WebSocketConnection) {return;}
        if (this.attempts < (this.config.maxReconnectAttempts ?? Infinity)) {
this.attempts += 1;
          this.reconnectTimer = setTimeout((): void => {
            if (!this.closed && this.gen === gen) {this.connect(this.url);}
          }, TieredTransport.BACKOFF_MS);
        }
      },onConnect: (): void => {
        if (gen !== this.gen) {return;}
        this.attempts = 0;
        this.connectedAt = Date.now();
        this.config.onConnect?.();
      },onMessage: (data: ServerMessage): void => { if (gen === this.gen) {this.config.onMessage?.(data);} },onBinaryMessage: (data: Uint8Array): void => { if (gen === this.gen) {this.config.onBinaryMessage?.(data);} }});
    connectGameTransport(innerConfig, this.opts).then((t): void => {
      if (this.closed || gen !== this.gen) { t.disconnect(); return; }
      this.inner = t;
      t.connect(url);
      for (const d of this.pending) {t.send(d);}
      this.pending.length = 0;
    return; }).catch((error): void => {
      if (gen !== this.gen) {return;}
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  send(data: string | Uint8Array): boolean {
    if (this.inner) {return this.inner.send(data);}
    // Binary frames are volatile state — keep only the freshest while the
    // probe resolves, same rule WebSocketConnection applies during downtime.
    // Keepalives are volatile too: a ping queued during a multi-second wt
    // probe flushes BEFORE the join the server demands first (the rejected-
    // handshake flap storm — every retry died on 'pre-join ping').
    if (typeof data === 'string' &&
        (data.startsWith('{"type":"ping"') || data.startsWith('{"type":"pong"') || data.startsWith('{"type":"clientStats"') || data.startsWith('{"type":"tickNack"'))) {
      return true;
    }
    if (data instanceof Uint8Array) {
      this.pending = this.pending.filter((m): boolean => !(m instanceof Uint8Array));
    }
    if (this.pending.length < 100) {this.pending.push(data);}
    return false;
  }

  connected(): boolean { return this.inner?.connected() ?? false; }
  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {clearTimeout(this.reconnectTimer);}
    this.inner?.disconnect();
  }
}
