import type { ServerWebSocket } from 'bun';
import type { WebSocketData, ServerMessage } from './types.ts';
import { logger } from './logger.ts';
import { wallNow } from './wallClock.ts';

/** Tick frames are drop-safe (peers extrapolate), so a socket that can't
 *  drain must not queue them unboundedly — a stalled connection otherwise
 *  grows memory while the player sees a worse-than-lossy feed. Above this
 *  backlog the frame is dropped before it hits the send queue. Only the
 *  tick hot path is gated; reliable control/ball traffic still queues. */
const MAX_TICK_BACKLOG = 256 * 1024;

/** Join-burst hold: a freshly seated client's outbox carries gameState +
 *  rosters + wireIds (often >256KB) while its main thread is still busy
 *  loading the world — every tick frame queued behind that burst is
 *  delivered stale or shed at the cap, and the seq gaps pollute loss
 *  telemetry with a pattern that isn't loss. Until the outbox first
 *  drains below this floor, tick frames are held (counted separately,
 *  not as drops); the introSeq full window reseeds the basis either
 *  way, so nothing the client could have decoded is lost. */
const INTRO_DRAIN_FLOOR = 32 * 1024;

/** Drowned-client drain: tick frames shed at 256KB, but reliable frames
 *  (joins, kills, chat, handshakes) queue into the transport buffer
 *  unconditionally — a reader that never drains parks megabytes of
 *  stale truth per socket with no one watching. Past this mark we start
 *  the clock; a socket still drowned after SLOW_FOR_MS is closed so the
 *  client reconnects through grace instead of buffering seconds-old
 *  state it can never render honestly. */
const DROWN_BYTES = 4 * 1024 * 1024;
const SLOW_FOR_MS = 5000;

/** Transient cues — a muzzle flash, a jump, a knockback shove. A reclaiming
 *  socket replays the journal after possibly seconds of grace; a stale cue
 *  replays as a phantom effect, while skipping it costs nothing because the
 *  reclaim's gameState reseeds every truth these could feed. State events
 *  (joins, kills, flag/deploy/pickup edges, chat) always replay — they carry
 *  durable fact a snapshot gap would lose. */
const VOLATILE_TYPES = new Set([
  'playerShot', 'jump', 'jetpack', 'knockback', 'playerHit',
  'projectileCreated', 'projectileDestroyed', 'claimAck',
]);

/** Periodic single-recipient echoes — journaled, each one burns a slot of
 *  the fixed 1024-frame replay window for a truth only one player needs.
 *  At a full roster (~2Hz echo each) they'd churn the whole window in
 *  ~8-16s and evict broadcast truth (kills, flag edges, chat) a reclaimer
 *  actually misses. A dead socket can't consume them anyway: gameState
 *  reseeds health on reclaim, and live echoes self-repeat at 2Hz. */
// stateHash joins the periodic-echo ban for a second reason: replaying
// a seconds-old hash against a replica that kept moving reads as a
// phantom desync + a spurious heal request, and the probe self-repeats
// every 2s — nothing a reclaim needs journaled. ping/pong too: each
// replayed ping earns a client pong (a reclaim burst tripped the
// rate limiter) and a stale echo would poison the transit EMA.
// gameState too: it's the largest frame type and a reclaimer's stale
// copy is always superseded by the fresh one sent right after replay —
// journaling it spends roster-sized replay bytes for nothing.
const NO_JOURNAL_TYPES = new Set(['yourHealth', 'yourCharge', 'stateHash', 'ping', 'pong', 'srvPing', 'gameState']);
const VOLATILE_TTL_MS = 3000;

export class ConnectionManager {
  private connections: Map<string, ServerWebSocket<WebSocketData>> = new Map();
  /** Pids whose post-join outbox has drained once — the tick intro gate
   *  holds frames until the join burst clears, not just on first seat. */
  private tickDrained: Set<string> = new Set();

  // Offset cursor (Socket.IO connection-state-recovery shape): every
  // reliable JSON frame carries a room-scoped `ev` seq, and the last N
  // frames sit in a journal. A reclaim presents the last seq it processed
  // and we replay only what its dead socket missed — cheaper than a blind
  // resnapshot and it preserves event causality. Binary lanes (ticks,
  // ball segments) skip the journal: ticks are drop-safe and the reclaim's
  // gameState+ballRoster already reseeds ball truth.
  private outSeq = 0;
  private journal: { seq: number; data: string; only?: string; exclude?: string; volatile?: boolean; at: number }[] = [];
  static readonly JOURNAL_MAX = 2048;
  /** splice(0,1) per push at saturation memmoves the whole journal every
   *  frame — evict in chunks so the copy amortizes. Cap is a steady-state
   *  target, not a hard bound; replay ordering and oldest-seq lookup are
   *  unchanged. */
  static readonly JOURNAL_EVICT_CHUNK = 128;
  /** Frames evicted from the journal before any in-flight reclaim could
   *  replay them — a gap the reclaiming client can never see again, so a
   *  nonzero count means a silent desync happened. The room folds this
   *  into its health counters; the owner can bump a tag on each wrap. */
  journalDropped = 0;
  onJournalWrap?: (dropped: number) => void;
  /** Frames a reclaim asked for that were already evicted — the client
   *  gets gameState truth but loses event history (kills, flag edges,
   *  chat). Counted so an undersized journal is visible, not silent. */
  reclaimGap = 0;
  onReclaimGap?: (playerId: string, missed: number) => void;
  /** Sockets closed by the drown drain — room health counts each via the
   *  callback so a pathological client shows up in the counters, not
   *  just the close log. */
  onDrowned?: (playerId: string) => void;
  /** Reliable frames uWS refused outright (send()===0, past the 16MB
   *  backpressureLimit). Rare under our own 4MB drown cap, but a real
   *  silent-loss channel: the client stays connected while truth
   *  evaporates. Counted like drowned sockets. */
  reliableDropped = 0;
  onReliableDropped?: (playerId: string) => void;

  /** Raw buffered-amount sample per reliable send — the room folds it
   *  into a bufMax gauge. Drown only fires past the cap; this surfaces
   *  the approach (a socket drowning for seconds before it dies). */
  onBuffered?: (playerId: string, bytes: number) => void;

  /** Reliable-lane sends all funnel through here on the way to a socket.
   *  A transient spike (reclaim replay burst) just starts the clock and
   *  drains under the hysteresis; a dead reader holds the mark and gets
   *  closed — skip sending into a socket already past the mark so the
   *  buffered byte count doesn't balloon while the clock runs. */
  private drownCheck(playerId: string, ws: ServerWebSocket<WebSocketData>): 'ok' | 'drowned' {
    const buffered = (ws as unknown as { getBufferedAmount?(): number }).getBufferedAmount?.() ?? 0;
    // Sockets without a data slot (test mocks) can't carry the mark —
    // buffered is also 0 there, so there's nothing to track anyway.
    if (!ws.data) {return 'ok';}
    if (buffered > 0) {this.onBuffered?.(playerId, buffered);}
    if (buffered < DROWN_BYTES) {
      ws.data.slowSince = undefined;
      return 'ok';
    }
    const since = ws.data.slowSince;
    if (since === undefined) {
      ws.data.slowSince = wallNow();
      return 'ok'; // first sighting — could be the reclaim burst
    }
    if (wallNow() - since < SLOW_FOR_MS) {return 'drowned';}
    logger.warn('closing drowned socket', { playerId, buffered, slowMs: wallNow() - since });
    this.onDrowned?.(playerId);
    try { ws.close(1011, 'slow client'); } catch { /* already closing */ }
    return 'drowned';
  }

  /** Reliable-lane send with status check. `send()` returns >0 sent,
   *  -1 queued under backpressure, 0 DROPPED — and a dropped reliable
   *  frame is the exact "pickup/damage silently missing" bug: the
   *  socket stays open while events vanish, and the journal only
   *  replays on reclaim. A drop means this socket can't be trusted:
   *  close it so the client reclaims and replays honestly. */
  private sendReliable(playerId: string, ws: ServerWebSocket<WebSocketData>, data: string | Uint8Array): void {
    const status = ws.send(data);
    if (status === 0) {
      this.reliableDropped += 1;
      this.onReliableDropped?.(playerId);
      logger.warn('reliable frame dropped by transport — closing to force reclaim', { playerId });
      try { ws.close(1011, 'reliable drop'); } catch { /* already closing */ }
    }
  }

  private frame(msg: ServerMessage, only?: string, exclude?: string): string {
    this.outSeq += 1;
    const seq = this.outSeq;
    const data = JSON.stringify(Object.assign({}, (msg as object), {ev: seq}));
    if (!NO_JOURNAL_TYPES.has((msg as { type: string }).type)) {
      const volatile_ = VOLATILE_TYPES.has((msg as { type: string }).type);
      this.journal.push({ seq, data, only, exclude, volatile: volatile_, at: wallNow() });
      if (this.journal.length > ConnectionManager.JOURNAL_MAX + ConnectionManager.JOURNAL_EVICT_CHUNK) {
        const n = this.journal.length - ConnectionManager.JOURNAL_MAX;
        this.journal.splice(0, n);
        this.journalDropped += n;
        this.onJournalWrap?.(n);
      }
    }
    return data;
  }

  /** Reclaim replay — frames addressed to everyone or to this player that
   *  arrived after their last processed seq. Runs before the handshake
   *  reply so gameState remains the final word on truth. */
  replayTo(playerId: string, ws: ServerWebSocket<WebSocketData>, fromSeq: number): number {
    const now = wallNow();
    let n = 0, skippedStale = 0;
    const oldest = this.journal.length > 0 ? this.journal[0]!.seq : this.outSeq + 1;
    const missed = oldest - fromSeq - 1;
    if (missed > 0) {
      this.reclaimGap += missed;
      this.onReclaimGap?.(playerId, missed);
    }
    // Cork the burst: replay fires up to ~1024 sends back-to-back —
    // batching them costs one flush instead of one syscall each.
    // (Test mocks have no cork — flush unbatched there.)
    const stale = (e: (typeof this.journal)[number]): boolean =>
      e.volatile === true && now - e.at > VOLATILE_TTL_MS;
    const eligible = (e: (typeof this.journal)[number]): boolean =>
      e.seq > fromSeq && !stale(e) &&
      (e.only === undefined || e.only === playerId) && e.exclude !== playerId;
    const pump = (): void => {
      for (const e of this.journal) {
        if (e.seq <= fromSeq) {continue;}
        if (stale(e)) {skippedStale += 1; continue;}
        if (!eligible(e)) {continue;}
        // Replay rides the same backpressure path as live sends — a
        // drowning socket gets its clock started (or closed) instead of
        // being re-flooded and silently dropping frames.
        if (this.drownCheck(playerId, ws) !== 'ok') {
          // The un-replayed tail was eligible for this recipient but never
          // sent — count it as a reclaim gap or the client's seq watermark
          // silently jumps past kills/chat it never saw.
          for (const rest of this.journal) {
            if (rest.seq < e.seq || !eligible(rest)) {continue;}
            this.reclaimGap += 1; truncated += 1;
          }
          if (truncated > 0) {this.onReclaimGap?.(playerId, truncated);}
          break;
        }
        this.sendReliable(playerId, ws, e.data);
        n += 1;
      }
    };
    let truncated = 0;
    if (typeof ws.cork === 'function') { ws.cork(pump); } else { pump(); }
    if (n > 0 || skippedStale > 0 || truncated > 0) {logger.info('reclaim replay', { playerId, fromSeq, replayed: n, skippedStale, truncated });}
    return n;
  }

  register(playerId: string, ws: ServerWebSocket<WebSocketData>): void {
    this.connections.set(playerId, ws);
    this.tickDrained.delete(playerId); // joins re-arm the intro hold
    logger.info(`Connection registered`, { playerId, total: this.connections.size });
  }

  unregister(playerId: string): void {
    const ws = this.connections.get(playerId);
    if (ws) {
      this.connections.delete(playerId);
      this.tickDrained.delete(playerId);
      logger.info(`Connection unregistered`, { playerId, total: this.connections.size });
    }
  }

  sendToPlayer(playerId: string, msg: ServerMessage): void {
    // Journal BEFORE delivery — a frame aimed at a dead/grace socket is
    // exactly what reclaim replay must find later.
    const data = this.frame(msg, playerId);
    const ws = this.connections.get(playerId);
    if (ws && ws.readyState === 1 && this.drownCheck(playerId, ws) === 'ok') {
      this.sendReliable(playerId, ws, data);
    }
  }

  /** Binary hot-path frames (tickUpdate) — no JSON.stringify. On WS
   *  this is the single TCP stream; on WT the adapter routes ticks to
   *  stream-2 (reliable, HoL-isolated) once the binLane caps handshake
   *  lands — measured ~33% seq loss on the QUIC datagram lane makes it
   *  unfit as the primary state lane (see _docs/2026-10-18_NETCODE_DEEP_DIVE_3). */
  /** Returns 'sent' | 'held' | 'backlogged' | 'gone' — 'held' is the
   *  intro gate (counted separately, not a loss); 'backlogged' is a real
   *  shed; a closing socket isn't a dropped frame. */
  sendBinaryToPlayer(playerId: string, data: Uint8Array): 'sent' | 'held' | 'backlogged' | 'gone' {
    const ws = this.connections.get(playerId);
    if (!ws || ws.readyState !== 1) {return 'gone';}
    const buffered = (ws as unknown as { getBufferedAmount?(): number }).getBufferedAmount?.() ?? 0;
    if (!this.tickDrained.has(playerId)) {
      if (buffered > INTRO_DRAIN_FLOOR) {return 'held';}
      this.tickDrained.add(playerId); // first clean sample — gate opens
    }
    if (buffered > MAX_TICK_BACKLOG) {
      // Backlogged sockets ALSO feed the drown clock — the cap sheds
      // frames but a reader that never drains must still be closed, or
      // a tick-only client lingers forever below DROWN_BYTES.
      this.drownCheck(playerId, ws);
      return 'backlogged';
    }
    ws.send(data);
    return 'sent';
  }

  /** Correctness-critical binary (ball segments) — always the reliable
   *  lane. A dropped segment is a resync the client free-runs blind for
   *  ~1.2s, which is exactly the rubberband pattern; a dropped tick frame
   *  is just interpolation noise. At ~50B × ~10/s per ball this is cheap.
   *  Still rides the drown check: a stalled reader otherwise queues
   *  segments forever and — since ticks ride the capped lane — a
   *  binary-only client would never even start the drain clock. The
   *  reclaim's ballRoster reseeds ball truth, so the skip is honest. */
  broadcastBinaryReliable(data: Uint8Array): void {
    this.connections.forEach((ws, pid): void => {
      if (ws.readyState === 1 && this.drownCheck(pid, ws) === 'ok') {this.sendReliable(pid, ws, data);}
    });
  }

  broadcast(msg: ServerMessage, excludePlayerId?: string): void {
    const data = this.frame(msg, undefined, excludePlayerId);
    this.connections.forEach((ws, pid): void => {
      if (excludePlayerId !== undefined && pid === excludePlayerId) {return;}
      if (ws.readyState === 1 && this.drownCheck(pid, ws) === 'ok') {
        this.sendReliable(pid, ws, data);
      }
    });
  }

  /** Intro-gate probe — false while a fresh seat's outbox still holds
   *  tick frames (its seq gaps are by design; its nacks are noise). */
  drainedForTicks(playerId: string): boolean {
    return this.tickDrained.has(playerId);
  }

  getConnection(playerId: string): ServerWebSocket<WebSocketData> | undefined {
    return this.connections.get(playerId);
  }

  isConnected(playerId: string): boolean {
    const ws = this.connections.get(playerId);
    return ws !== undefined && ws.readyState === 1;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  /** Graceful teardown: a real close frame (not a severed socket) tells
   *  the client WHY the session ended — 1001 'going away' reads as
   *  'server restarting' on the reconnect banner instead of a mystery
   *  drop that looks like their own connection died. */
  closeAll(code: number, reason: string): void {
    this.connections.forEach((ws): void => {
      if (ws.readyState === 1) {
        try { ws.close(code, reason); } catch { /* already closing */ }
      }
    });
  }
}
