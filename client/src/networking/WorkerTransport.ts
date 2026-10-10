/**
 * WorkerTransport — GameTransport facade that lives on the main thread
 * while the real socket stack runs inside netWorker. Inbound events are
 * buffered and drained once per event-loop turn (setTimeout 0 chain), so
 * a stalled main thread coalesces the pile-up: superseded tick frames
 * never reach the game, only the newest does — the "200ms of snapshots
 * replayed as a rubberband storm" case collapses to one application.
 */

import type { ConnectionConfig } from './WebSocketConnection.js';
import type { GameTransport } from './transport.js';
import type { ServerMessage } from '../../../shared/protocol.js';
import type { NetLogLevel } from './netLog.js';
import { urlParams } from '../core/params.js';
import { ChildLogger } from '../core/Logger.js';
import { WIRE_TICK, WIRE_TICK_V1, WIRE_TICK_V3, WIRE_TICK_V4 } from '../../../shared/wire.js';

const logger = new ChildLogger('NetW');

/** Wire frame kinds that carry whole-world tick state — only the newest
 *  is ever worth applying (see shared/wire.ts header layout). */
const TICK_KINDS = new Set([WIRE_TICK, WIRE_TICK_V1, WIRE_TICK_V3, WIRE_TICK_V4]);
const MAGIC = 0x54; // 'T' — shared/wire.ts frame magic

type Ev =
  | { kind: 'up'; tier: string | undefined }
  | { kind: 'down'; code?: number; reason?: string }
  | { kind: 'err'; msg: string }
  | { kind: 'ev'; j: ServerMessage; at: number }
  | { kind: 'ev'; b: Uint8Array; at: number }
  | { kind: 'rtt'; rtt: number }
  | { kind: 'resolve'; seq: number }
  | { kind: 'nlog'; level: NetLogLevel; name: string; msg: string; ctx?: unknown };

/** Drop every queued tick frame but the newest — a stall backlog replays
 *  history the server already superseded. Returns the filtered list,
 *  preserving order of everything else. */
export function coalesceTickFrames(evs: Ev[]): Ev[] {
  let lastTick = -1;
  let maxSeq = -1;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]!;
    if (e.kind === 'ev' && 'b' in e && e.b.length >= 10 && e.b[0] === MAGIC && TICK_KINDS.has(e.b[1]!)) {
      const seq = new DataView(e.b.buffer, e.b.byteOffset).getUint32(6, true);
      if (seq > maxSeq) { maxSeq = seq; lastTick = i; }
    }
  }
  if (lastTick < 0) {return evs;}
  return evs.filter((e, i) => {
    if (e.kind !== 'ev' || !('b' in e) || i === lastTick) {return true;}
    return !(e.b.length >= 10 && e.b[0] === MAGIC && TICK_KINDS.has(e.b[1]!));
  });
}

export class WorkerTransport implements GameTransport {
  /** Worker owns the ping cadence — NetworkManager must not double-send. */
  readonly ownsPing = true;
  /** Clean wire RTT (worker's clock) + worker→main delivery lag. */
  readonly netProbe = { rttMs: 0, lagMs: 0 };

  private worker: Worker;
  private open = false;
  private innerTier: string | undefined;
  private pending: Ev[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private coalesced = 0;

  constructor(private readonly config: ConnectionConfig) {
    this.worker = new Worker(new URL('./netWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Ev>) => this.enqueue(e.data);
    this.worker.onerror = (e) => {
      logger.error('net worker error', e.message);
      config.onError?.(new Error(e.message || 'net worker crashed'));
    };
    this.worker.postMessage({ kind: 'init', net: urlParams.net ?? undefined });
  }

  get tier() { return this.innerTier as GameTransport['tier']; }

  connect(url?: string): void {
    this.worker.postMessage({ kind: 'connect', url: url ?? this.config.url, resolve: this.config.resolveUrl !== undefined });
  }

  send(data: string | Uint8Array): boolean {
    if (typeof data === 'string') { this.worker.postMessage({ kind: 'send', s: data }); }
    else { this.worker.postMessage({ kind: 'send', b: new Uint8Array(data) }); }
    return this.open;
  }

  connected(): boolean { return this.open; }

  disconnect(): void {
    this.open = false;
    this.pending.length = 0;
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    this.worker.postMessage({ kind: 'disconnect' });
    // Each NetworkManager.connect() spawns a fresh worker — give this one
    // a beat to shut its lane down, then retire it or dead workers pile
    // up across stall-reconnects.
    const w = this.worker;
    setTimeout(() => w.terminate(), 500);
  }

  private enqueue(ev: Ev): void {
    if (ev.kind === 'nlog') {
      // Transport logs run in the worker — relay into the real buffer so
      // Alt+Q still sees tier/reconnect lines.
      const l = new ChildLogger(ev.name);
      (l[ev.level] as (m: string, c?: unknown) => void).call(l, ev.msg, ev.ctx);
      return;
    }
    if (ev.kind === 'resolve') {
      void Promise.resolve(this.config.resolveUrl?.() ?? null)
        .then((url) => this.worker.postMessage({ kind: 'resolved', seq: ev.seq, url }));
      return;
    }
    if (ev.kind === 'rtt') { this.netProbe.rttMs = ev.rtt; this.config.onRtt?.(ev.rtt); }
    if (ev.kind === 'ev') { this.netProbe.lagMs = Date.now() - ev.at; }
    this.pending.push(ev);
    // Draining on the NEXT macrotask lets every already-queued message
    // land in the same batch — free stall coalescing, ~0 added latency
    // when the loop is healthy.
    if (!this.drainTimer) {
      this.drainTimer = setTimeout(() => { this.drainTimer = null; this.drain(); }, 0);
    }
  }

  private drain(): void {
    const evs = coalesceTickFrames(this.pending);
    this.coalesced += this.pending.length - evs.length;
    this.pending.length = 0;
    for (const ev of evs) {
      switch (ev.kind) {
        case 'up': this.open = true; this.innerTier = ev.tier; this.config.onConnect?.(); break;
        case 'down': this.open = false; this.config.onDisconnect?.(ev.code, ev.reason); break;
        case 'err': this.config.onError?.(new Error(ev.msg)); break;
        case 'ev': if ('j' in ev) {this.config.onMessage?.(ev.j);} else {this.config.onBinaryMessage?.(ev.b);} break;
      }
    }
  }

  /** Alt+Q: how many stale tick frames the drain dropped this session. */
  get coalescedTicks(): number { return this.coalesced; }

  /** rtt/lag read for the dump — null on non-worker transports. */
  get probe(): { rttMs: number; lagMs: number; coalesced: number } {
    return { rttMs: this.netProbe.rttMs, lagMs: this.netProbe.lagMs, coalesced: this.coalesced };
  }
}
