/* oxlint-disable unicorn/require-post-message-target-origin -- every postMessage here targets the dedicated Worker (no targetOrigin param exists) */
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
  | { kind: 'ev'; j?: ServerMessage; b?: Uint8Array; at: number }
  // Batched worker→main posts — the worker packs every event ready at
  // turn end into one postMessage (post cost is per-call; measured
  // drainMsMax=41ms for 338 one-at-a-time posts). Items flatten into
  // the same pending queue; per-item `at` keeps lag honest.
  | { kind: 'evs'; items: { j?: ServerMessage; b?: Uint8Array; at: number }[] }
  | { kind: 'rtt'; rtt: number }
  | { kind: 'resolve'; seq: number }
  | { kind: 'nlog'; level: NetLogLevel; name: string; msg: string; ctx?: unknown };

/** Drop every queued tick frame but the newest — a stall backlog replays
 *  history the server already superseded. Returns the filtered list,
 *  preserving order of everything else.
 *
 *  BUT: a tick frame isn't one position — it's every player's records
 *  for that tick. Dropping a frame starves the interp buffer of the
 *  intermediate snapshots it interpolates between, which reads as
 *  rubber-banding on a healthy link. Only coalesce when the backlog is
 *  deep enough that the oldest frame is stale anyway (>3 queued ticks
 *  ≈ >150ms behind); 2-3 frame batches play through in order instead. */
export function coalesceTickFrames(evs: Ev[], stalled: boolean): Ev[] {
  let lastTick = -1;
  let maxSeq = -1;
  let tickCount = 0;
  for (let i = 0; i < evs.length; i += 1) {
    const e = evs[i]!;
    if (e.kind === 'ev' && e.b !== undefined && e.b.length >= 10 && e.b[0] === MAGIC && TICK_KINDS.has(e.b[1]!)) {
      tickCount += 1;
      const seq = new DataView(e.b.buffer, e.b.byteOffset).getUint32(6, true);
      if (seq > maxSeq) { maxSeq = seq; lastTick = i; }
    }
  }
  // Only coalesce a REAL stall — backlog measured against the drain's own
  // cadence, not a fixed depth. A busy-but-healthy burst (>3 frames from a
  // coalesced server batch) plays through; dropping it starves the interp
  // buffer and reads as rubber-banding — the fixed ">3" guessed wrong.
  if (!stalled || lastTick < 0 || tickCount <= 3) {return evs;}
  return evs.filter((e, i): boolean => {
    if (e.kind !== 'ev' || e.b === undefined || i === lastTick) {return true;}
    return !(e.b.length >= 10 && e.b[0] === MAGIC && TICK_KINDS.has(e.b[1]!));
  });
}

export class WorkerTransport implements GameTransport {
  /** Worker owns the ping cadence — NetworkManager must not double-send. */
  readonly ownsPing = true;
  /** Clean wire RTT (worker's clock) + worker→main delivery lag. */
  readonly netProbe = { rttMs: 0, lagMs: 0, lagMsMax: 0, maxPending: 0, lastRxAt: 0, drainMsMax: 0 };

  private worker: Worker;
  private open = false;
  private innerTier: string | undefined;
  private pending: Ev[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private drainGapEma = 16;
  private lastDrainAt = 0;
  private coalesced = 0;

  constructor(private readonly config: ConnectionConfig) {
    this.worker = new Worker(new URL('./netWorker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (e: MessageEvent<Ev>): void => this.enqueue(e.data));
    this.worker.addEventListener('error', (e): void => {
      logger.error('net worker error', e.message);
      config.onError?.(new Error(e.message || 'net worker crashed'));
      // A crashed worker is a dead lane — fire 'down' so the session
      // reprobes now instead of waiting the 4s silence watchdog. Queued
      // inbound events drain first or they'd replay into the post-down
      // roster/seq reset out of wire order.
      if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
      this.drain();
      this.open = false;
      config.onDisconnect?.(1006, 'net worker crashed');
    });
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
    setTimeout((): void => w.terminate(), 500);
  }

  private enqueue(ev: Ev): void {
    if (ev.kind === 'evs') {
      // Flatten the batch — each item runs the same stamp/push path as a
      // lone post; the queue then coalesces stale tick frames as usual.
      for (const item of ev.items) {this.enqueue({ kind: 'ev', j: item.j, b: item.b, at: item.at });}
      return;
    }
    if (ev.kind === 'nlog') {
      // Transport logs run in the worker — relay into the real buffer so
      // Alt+Q still sees tier/reconnect lines.
      const l = new ChildLogger(ev.name);
      (l[ev.level] as (m: string, c?: unknown) => void).call(l, ev.msg, ev.ctx);
      return;
    }
    if (ev.kind === 'resolve') {
      Promise.resolve(this.config.resolveUrl?.() ?? null)
        .then((url): void => this.worker.postMessage({ kind: 'resolved', seq: ev.seq, url })).catch((): void => undefined);
      return;
    }
    if (ev.kind === 'rtt') {
      // Probe event — apply at the edge; queueing it to drain would just
      // churn the batch as a no-op case every ping cycle.
      this.netProbe.rttMs = ev.rtt;
      this.config.onRtt?.(ev.rtt);
      return;
    }
    if (ev.kind === 'ev') {
      this.netProbe.lagMs = Date.now() - ev.at;
      if (this.netProbe.lagMs > this.netProbe.lagMsMax) {this.netProbe.lagMsMax = this.netProbe.lagMs;}
      // Liveness is a RECEIVE property — stamp it at the edge, not at
      // drain time, or a render stall reads as a dead socket to the
      // silence watchdog and tears down a healthy session.
      this.netProbe.lastRxAt = Date.now();
    }
    this.pending.push(ev);
    if (this.pending.length > this.netProbe.maxPending) {this.netProbe.maxPending = this.pending.length;}
    // Draining on the NEXT macrotask lets every already-queued message
    // land in the same batch — free stall coalescing, ~0 added latency
    // when the loop is healthy.
    if (!this.drainTimer) {
      this.drainTimer = setTimeout((): void => { this.drainTimer = null; this.drain(); }, 0);
    }
  }

  private drain(): void {
    // coalesceTickFrames may return its input unchanged — swap the queue
    // out by reference first or clearing pending would drain `evs` too.
    const {pending} = this;
    this.pending = [];
    // A stall is measured, not guessed: this drain ran >3x the observed
    // drain cadence late (main-thread hitch, GC, tab jank). Normal batched
    // delivery lands at-cadence and keeps every frame — the fixed ">3
    // backlog" guess dropped healthy bursts and read as rubber-banding.
    const drainAt = performance.now();
    const drainGap = this.lastDrainAt > 0 ? drainAt - this.lastDrainAt : 16;
    this.lastDrainAt = drainAt;
    const stalled = drainGap > Math.max(100, this.drainGapEma * 3);
    this.drainGapEma += (Math.min(drainGap, 1000) - this.drainGapEma) * 0.1;
    const evs = coalesceTickFrames(pending, stalled);
    this.coalesced += pending.length - evs.length;
    // Time-slice the dispatch: a reclaim replay delivers ~1024 events in
    // one burst — one unbounded macrotask hitched the frame at exactly
    // the rejoin moment. 8ms per turn, leftovers ride the next tick of
    // the same ordering.
    const drainStart = performance.now();
    const deadline = drainStart + 8;
    let i = 0;
    for (; i < evs.length; i++) {
      if (i > 0 && (i & 63) === 0 && performance.now() > deadline) {break;}
      const ev = evs[i]!;
      try {
        switch (ev.kind) {
          case 'up': { this.open = true; this.innerTier = ev.tier; this.config.onConnect?.(); break;
          }
          case 'down': { this.open = false; this.config.onDisconnect?.(ev.code, ev.reason); break;
          }
          case 'err': { this.config.onError?.(new Error(ev.msg)); break;
          }
          case 'ev': { if (ev.j !== undefined) {this.config.onMessage?.(ev.j);} else if (ev.b !== undefined) {this.config.onBinaryMessage?.(ev.b);} break;
          }
                  default: { break; }
}
      } catch (error) {
        logger.error(`drain dispatch threw on ${ev.kind}`, error instanceof Error ? error.message : String(error));
      }
    }
    // drainMsMax answers "is the worker boundary worth batching": if it
    // stays low under reclaim bursts, per-message posts are already
    // cheap enough that batching would be complexity for nothing.
    const drainMs = performance.now() - drainStart;
    if (drainMs > this.netProbe.drainMsMax) {this.netProbe.drainMsMax = drainMs;}
    if (i < evs.length) {
      this.pending.unshift(...evs.slice(i));
      this.drainTimer ??= setTimeout((): void => { this.drainTimer = null; this.drain(); }, 0);
    }
  }

  /** Alt+Q: how many stale tick frames the drain dropped this session. */
  get coalescedTicks(): number { return this.coalesced; }

  /** rtt/lag read for the dump — null on non-worker transports. */
  get probe(): { rttMs: number; lagMs: number; lagMsMax: number; maxPending: number; coalesced: number; lastRxAt: number; drainMsMax: number } {
    return { rttMs: this.netProbe.rttMs, lagMs: this.netProbe.lagMs, lagMsMax: this.netProbe.lagMsMax, maxPending: this.netProbe.maxPending, coalesced: this.coalesced, lastRxAt: this.netProbe.lastRxAt, drainMsMax: this.netProbe.drainMsMax };
  }
}
