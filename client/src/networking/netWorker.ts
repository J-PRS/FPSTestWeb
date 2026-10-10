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
  postMessage(m: unknown): void;
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

// --- Ping: owned here so the RTT is measured on an unstarved clock. ----
// The client's pong reply to a SERVER ping still originates on main —
// so the server's own srvPing keeps capturing main-thread stall while
// this probe reads the clean wire number. Both samples stay meaningful.
const PING_INTERVAL = 2500;
let lastPingAt = 0;
setInterval(() => {
  if (!connected || !inner?.connected()) {return;}
  const now = Date.now();
  lastPingAt = now;
  inner.send(JSON.stringify({ type: 'ping', timestamp: now }));
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
        })
      : undefined,
    onConnect: () => { connected = true; post({ kind: 'up', tier: inner?.tier }); },
    onDisconnect: (code, reason) => { connected = false; post({ kind: 'down', code, reason }); },
    onError: (e) => post({ kind: 'err', msg: e.message }),
    onMessage: (m) => {
      // Inbound 'pong' is only ever a reply to a client 'ping' — ours.
      // Consume it here: main feeds its telemetry from the rtt event
      // instead of re-measuring stamp→receipt (which would fold the
      // main-thread queue delay back into the number).
      if ((m as { type?: string }).type === 'pong') {
        const stamp = (m as { timestamp?: number }).timestamp;
        if (typeof stamp === 'number' && stamp >= lastPingAt) {
          post({ kind: 'rtt', rtt: Date.now() - stamp });
          return;
        }
      }
      post({ kind: 'ev', j: m, at: Date.now() });
    },
    onBinaryMessage: (b) => post({ kind: 'ev', b, at: Date.now() }),
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
      if (inner) { const old = inner; inner = null; old.disconnect(); }
      inner = new TieredTransport(makeConfig(m.url, m.resolve), opts);
      inner.connect(m.url);
      break;
    }
    case 'send': {
      const ok = 's' in m ? inner?.send(m.s) : inner?.send(m.b);
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
