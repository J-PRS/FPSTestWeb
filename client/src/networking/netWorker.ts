/**
 * Net worker — owns the whole transport stack (tier race, ws/wt/rtc
 * lanes, reconnect machinery) on a dedicated event loop. Why it exists:
 * Blink queues WebSocket delivery at kNormalPriority and never
 * anti-starves it — under mousedown+mousemove (an FPS's busiest input)
 * or a heavy frame, onmessage can sit 60ms+ behind render work. In here
 * nothing competes with render or input: messages are received at wire
 * speed, and the ping/pong RTT is measured on this loop's clock, so the
 * number means "network" again instead of "main-thread queue depth".
 *
 * The main thread sees a GameTransport-shaped bridge (WorkerTransport);
 * decoded events cross as plain postMessage payloads and are drained +
 * coalesced on the far side.
 */

import type { ConnectionConfig } from './WebSocketConnection.js';
import type { GameTransport } from './transport.js';
import { TieredTransport } from './tiers.js';
import { setNetLogSink, type NetLogLevel } from './netLog.js';
import type { ServerMessage } from '../../../shared/protocol.js';

// Worker context — the DOM lib types `self` as Window, so cast to the
// dedicated-worker scope for the worker global APIs.
const w = self as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

type Up =
  | { kind: 'up'; tier: string | undefined }
  | { kind: 'down'; code?: number; reason?: string }
  | { kind: 'err'; msg: string }
  | { kind: 'ev'; j: ServerMessage; at: number }
  | { kind: 'ev'; b: Uint8Array; at: number }
  | { kind: 'rtt'; rtt: number }
  | { kind: 'resolve'; seq: number }
  | { kind: 'nlog'; level: NetLogLevel; name: string; msg: string; ctx?: unknown };

type Down =
  | { kind: 'init'; net?: string }
  | { kind: 'connect'; url: string; resolve: boolean }
  | { kind: 'send'; s: string }
  | { kind: 'send'; b: Uint8Array }
  | { kind: 'disconnect' }
  | { kind: 'resolved'; seq: number; url: string | null };

const post = (m: Up) => w.postMessage(m);

// Transport logs surface in the page's Alt+Q buffer, not just the
// worker's devtools console — relay them as protocol messages.
setNetLogSink((level, name, msg, ctx) => post({ kind: 'nlog', level, name, msg, ctx }));

let inner: GameTransport | null = null;
let opts: { net?: string } = {};
let connected = false;
// True once main has forwarded its first send (always 'join') — the
// worker's own ping must never race it: QUIC lanes are unordered across
// streams, so a ping landing before join gets the session closed as
// 'Expected join handshake' (the wt flap loop this gate ended).
let seated = false;
// Sends that arrive while the lane is mid-probe used to be dropped —
// the join included, which left fresh sessions with no handshake until
// the server's join-timeout killed them (the silent half of the flap).
// Bounded FIFO flushed on connect keeps the ordering guarantee
// WebSocketConnection::KEEP_ALWAYS gave the main-thread path.
const sendQueue: (string | Uint8Array)[] = [];
const SEND_QUEUE_MAX = 64;
// --- Ping: owned here so the RTT is measured on an unstarved clock. ----
// The client's pong reply to a SERVER ping still originates on main —
// so the server's own srvPing keeps capturing main-thread stall while
// this probe reads the clean wire number. Both samples stay meaningful.
const PING_INTERVAL = 2500;
setInterval(() => {
  if (!connected || !seated || !inner?.connected()) {return;}
  inner.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
}, PING_INTERVAL);

/** resolveUrl is a main-thread callback (matchmaker). Bridge it as a
 *  request/response pair — the transport's reconnect path awaits it. */
let resolveSeq = 0;
const resolveWaiters = new Map<number, (url: string | null) => void>();

function makeConfig(url: string, hasResolver: boolean): ConnectionConfig {
  return {
    url,
    resolveUrl: hasResolver
      ? () => new Promise<string | null>((res) => {
          const seq = ++resolveSeq;
          resolveWaiters.set(seq, res);
          post({ kind: 'resolve', seq });
          // A reply that never comes (disconnect mid-flight, a stalled
          // matchmaker) must not park the reconnect promise forever.
          setTimeout(() => {
            if (resolveWaiters.delete(seq)) {res(null);}
          }, 10_000);
        })
      : undefined,
    onConnect: () => {
      connected = true;
      for (const q of sendQueue.splice(0)) inner?.send(q);
      post({ kind: 'up', tier: inner?.tier });
    },
    onDisconnect: (code, reason) => { connected = false; post({ kind: 'down', code, reason }); },
    onError: (e) => post({ kind: 'err', msg: e.message }),
    onMessage: (m) => {
      // Inbound 'pong' is only ever a reply to a client 'ping' — ours.
      // Consume it here: main feeds its telemetry from the rtt event
      // instead of re-measuring stamp→receipt (which would fold the
      // main-thread queue delay back into the number).
      if ((m as { type?: string }).type === 'pong') {
        const stamp = (m as { timestamp?: number }).timestamp;
        // Consume EVERY pong — they only exist as replies to our pings.
        // A stale one (arrived after the next ping went out) used to fall
        // through to main's pongReceived, which feeds the same telemetry
        // with stamp→receipt — re-polluting the clean worker RTT with
        // main-loop queue delay. now−stamp on the worker clock is the
        // honest number either way.
        if (typeof stamp === 'number') {
          post({ kind: 'rtt', rtt: Date.now() - stamp });
          return;
        }
      }
      post({ kind: 'ev', j: m, at: Date.now() });
    },
    onBinaryMessage: (b) => {
      // Transfer, don't clone — tick frames arrive at 20Hz and run tens
      // of KB, so a per-frame structured clone was the new dominant copy.
      // Only transferable when the view owns its whole buffer; a subarray
      // view falls back to a slice so we don't detach a pooled parent.
      const buf = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
        ? b.buffer : b.slice().buffer;
      w.postMessage({ kind: 'ev', b: new Uint8Array(buf), at: Date.now() }, [buf]);
    },
  };
}

w.onmessage = (e: MessageEvent<Down>) => {
  const m = e.data;
  switch (m.kind) {
    case 'init':
      opts = { net: m.net };
      break;
    case 'connect': {
      // A lingering lane from a previous connect gets torn down here —
      // orphan sockets are the parallel-join flood source.
      seated = false;
      if (inner) { const old = inner; inner = null; old.disconnect(); }
      inner = new TieredTransport(makeConfig(m.url, m.resolve), opts);
      inner.connect(m.url);
      break;
    }
    case 'send': {
      seated = true;
      const payload = 's' in m ? m.s : m.b;
      const ok = inner?.send(payload);
      if (!ok) { sendQueue.push(payload); }
      while (sendQueue.length > SEND_QUEUE_MAX) sendQueue.shift();
      // A lane that reports dead without a disconnect event was the
      // contract-violation scream on main — keep it visible here.
      if (ok === false && connected) {
        post({ kind: 'nlog', level: 'warn', name: 'NetW', msg: 'inner lane dropped a send while reporting connected' });
      }
      break;
    }
    case 'disconnect':
      connected = false;
      inner?.disconnect();
      inner = null;
      // In-flight resolves can never be answered now — fail them fast
      // instead of parking the next transport's reconnect on the timeout.
      for (const res of resolveWaiters.values()) {res(null);}
      resolveWaiters.clear();
      break;
    case 'resolved':
      resolveWaiters.get(m.seq)?.(m.url);
      resolveWaiters.delete(m.seq);
      break;
  }
};

// DedicatedWorkerGlobalScope.onmessage assignment is the actual entry —
// keep the export so bundlers treat this as a module.
export {};
