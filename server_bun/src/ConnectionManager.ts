import type { ServerWebSocket } from 'bun';
import type { WebSocketData, ServerMessage } from './types.ts';
import { logger } from './logger.ts';
import { wallNow } from './wallClock.ts';
import { wireTx, wireClose, BIN_KIND } from './wireMeter.ts';
import { encodeBatch, encodeWireJson, tickFrameScratch, isEvScratch, type TickFrameScratch } from '../../shared/wire.ts';

/** Tick frames are drop-safe (peers extrapolate), so a socket that can't
 *  drain must not queue them unboundedly -- a stalled connection otherwise
 *  grows memory while the player sees a worse-than-lossy feed. Above this
 *  backlog the frame is dropped before it hits the send queue. Only the
 *  tick hot path is gated; reliable control/ball traffic still queues. */
const MAX_TICK_BACKLOG = 256 * 1024;
/** Sparse keepalive on backlogged sockets -- every 4th tick rides through
 *  (~5Hz at 20Hz) instead of all-or-nothing silence. A congested-but-
 *  draining link keeps remotes alive at degrade cadence (interest
 *  philosophy: degrade, never cull); a truly dead reader still feeds the
 *  drown clock and closes on the same schedule. */
const SHED_KEEPALIVE = 4;
/** Intro-gate grace: ~3s at 20Hz. A join burst legitimately takes
 *  seconds to drain on a slow link -- 'held' is honest while it does.
 *  Past the grace it's a socket that never drains: degrade to the
 *  sparse lane rather than starving the client silently forever. */
const HELD_GRACE_TICKS = 60;

/** Join-burst hold: a freshly seated client's outbox carries gameState +
 *  rosters + wireIds (often >256KB) while its main thread is still busy
 *  loading the world -- every tick frame queued behind that burst is
 *  delivered stale or shed at the cap, and the seq gaps pollute loss
 *  telemetry with a pattern that isn't loss. Until the outbox first
 *  drains below this floor, tick frames are held (counted separately,
 *  not as drops); the introSeq full window reseeds the basis either
 *  way, so nothing the client could have decoded is lost. */
const INTRO_DRAIN_FLOOR = 32 * 1024;

/** Drowned-client drain: tick frames shed at 256KB, but reliable frames
 *  (joins, kills, chat, handshakes) queue into the transport buffer
 *  unconditionally -- a reader that never drains parks megabytes of
 *  stale truth per socket with no one watching. Past this mark we start
 *  the clock; a socket still drowned after SLOW_FOR_MS is closed so the
 *  client reconnects through grace instead of buffering seconds-old
 *  state it can never render honestly. */
const DROWN_BYTES = 4 * 1024 * 1024;
const SLOW_FOR_MS = 5000;

/** Transient cues -- a muzzle flash, a jump, a knockback shove. A reclaiming
 *  socket replays the journal after possibly seconds of grace; a stale cue
 *  replays as a phantom effect, while skipping it costs nothing because the
 *  reclaim's gameState reseeds every truth these could feed. State events
 *  (joins, kills, flag/deploy/pickup edges, chat) always replay -- they carry
 *  durable fact a snapshot gap would lose. */
const VOLATILE_TYPES = new Set([
  'playerShot', 'jump', 'jetpack', 'knockback', 'playerHit',
  'projectileCreated', 'projectileDestroyed', 'claimAck',
]);

/** Periodic single-recipient echoes -- journaled, each one burns a slot of
 *  the fixed 1024-frame replay window for a truth only one player needs.
 *  At a full roster (~2Hz echo each) they'd churn the whole window in
 *  ~8-16s and evict broadcast truth (kills, flag edges, chat) a reclaimer
 *  actually misses. A dead socket can't consume them anyway: gameState
 *  reseeds health on reclaim, and live echoes self-repeat at 2Hz. */
// stateHash joins the periodic-echo ban for a second reason: replaying
// a seconds-old hash against a replica that kept moving reads as a
// phantom desync + a spurious heal request, and the probe self-repeats
// every 2s -- nothing a reclaim needs journaled. ping/pong too: each
// replayed ping earns a client pong (a reclaim burst tripped the
// rate limiter) and a stale echo would poison the transit EMA.
// gameState too: it's the largest frame type and a reclaimer's stale
// copy is always superseded by the fresh one sent right after replay --
// journaling it spends roster-sized replay bytes for nothing.
const NO_JOURNAL_TYPES = new Set(['yourHealth', 'yourCharge', 'yourAmmo', 'stateHash', 'ping', 'pong', 'srvPing', 'gameState']);
const VOLATILE_TTL_MS = 3000;
/** Cosmetic lines -- notices, chat, warns. Their truth (scores, roster,
 *  gates) reseeds through the reclaim's gameState; the text itself is
 *  presentation, and replaying it re-fires banners + TTS from a dead
 *  tab's past. A short window still catches a brief flap's missed frag
 *  line, an F5 doesn't dump the stale feed. Kill/deploy/flag edges stay
 *  durable -- killCounts ride their deltas with no snapshot echo. */
const COSMETIC_TTL = new Map<string, number>([['matchNotice', 15_000], ['chat', 15_000], ['serverWarn', 15_000]]);
/** FPS_WIRESPY=1 -- emit-time wire forensics (which pids a keepalive/
 *  broadcast actually targets). Hoisted once: env reads on a per-frame
 *  hot path cost a map lookup every send. */
const WIRESPY = typeof process !== 'undefined' && Boolean(process.env.FPS_WIRESPY);

export class ConnectionManager {
  /** uWS native fanout: identical payloads (reliable broadcasts, ball
   *  batches, proj edges) build the frame once and publish to every
   *  subscribed socket -- ~88% of send calls on a combat room collapse
   *  into one `server.publish` per frame. One fn PER Bun.serve listener:
   *  publish() only reaches subscribers of its own uWS server, so the
   *  direct-TLS listener needs its own entry or its sockets (marked
   *  pubbed, skipped by sendReliable) silently lose every async
   *  broadcast -- the missing-playerRespawn desync. Set in server.ts
   *  after each Bun.serve; absent in tests → the per-conn path stands. */
  static publishFns = new Set<(topic: string, data: string | Uint8Array) => void>();
  /** UDP volatile lane (native-shell clients): returns true when the
   *  tick frame rode out over the bound datagram lane -- the ws path is
   *  skipped entirely (control/reliable traffic never touches this).
   *  Set once in server.ts when FPS_UDP_PORT is live. */
  static udpSend: ((playerId: string, data: Uint8Array) => boolean) | undefined;
  /** Session-end hook -- unbinds the udp lane so a stale token dies with
   *  the session. Set alongside udpSend. */
  static onUnreg: ((playerId: string) => void) | undefined;
  /** Lane-alive probe for emit-time display ('ws+udp' scoreboard tier). */
  static udpLive: ((playerId: string) => boolean) | undefined;
  private topic?: string;
  /** Pids whose socket took a subscribe (real uWS ws) -- adapters (wt/rtc
   *  lanes) never join the topic and keep per-conn sends. */
  private readonly pubbed = new Set<string>();

  setTopic(topic: string): void { this.topic = topic; }

  /** Per-conn tick coalescing: between beginCollect/flushOutboxes every
   *  outbound frame queues per recipient; the flush ships ONE ws.send
   *  per conn carrying [in-tick events..., tick frame] as a WIRE_BATCH.
   *  Outside the window sends stay immediate -- no latency change for
   *  async events (joins, reclaims, timers). The batch framing bytes
   *  (~4B/subframe) aren't metered; per-frame kind detail is kept by
   *  metering at queue time, not at the merged send. */
  private collecting = false;
  /** Armed by the first tick -- volatile cues arriving between flushes
   *  queue into the NEXT flush's batch instead of a send each (the
   *  cpuprofile's top line was per-event ws.send fanout). Non-ticking
   *  harnesses never arm it and keep the immediate path. */
  private ticksRunning = false;
  private readonly outbox = new Map<string, Uint8Array[]>();
  /** Batch-encode scratch -- ws.send consumes the bytes synchronously, so
   *  one growable buffer serves every conn's batch (per-conn arenas are
   *  for frames that OUTLIVE their encode, the batch doesn't). Test mocks
   *  that keep the sent Uint8Array MUST .slice() it -- a retained view
   *  silently rewrites to the next conn's batch (firstSeat flake). */
  private batchScratch = new Uint8Array(64 * 1024);
  /** Per-conn tick-frame arena -- the outbox RETAINS the encoded view
   *  until flush, so every conn needs its own buffer: a shared arena
   *  aliases every queued frame to the last-encoded one (the fanout
   *  encodes recipient A, queues the view, then recipient B's encode
   *  overwrites A's bytes mid-batch). One frame per conn per tick, so
   *  a per-conn arena is exactly enough. */
  private readonly frameArenas = new Map<string, TickFrameScratch>();
  frameArenaFor(pid: string): TickFrameScratch {
    let a = this.frameArenas.get(pid);
    if (!a) {a = tickFrameScratch(); this.frameArenas.set(pid, a);}
    return a;
  }
  beginCollect(): void { this.collecting = true; this.ticksRunning = true; }
  private push(pid: string, frame: Uint8Array): void {
    // evScratch views are only valid until the ring wraps (128 encodes)
    // -- a queued frame would otherwise flush as a DIFFERENT event
    // (a playerHit arriving as a knock: the missing-damage class).
    // Copy only what needs retention; immediate ws.send consumes the
    // scratch synchronously and stays alloc-free.
    if (isEvScratch(frame)) {frame = frame.slice();}
    let q = this.outbox.get(pid);
    if (!q) {q = []; this.outbox.set(pid, q);}
    q.push(frame);
  }
  /** Send-cost telemetry -- counts actual ws.send calls + elapsed inside
   *  flush so the per-call cost is measured, not guessed. Folded into
   *  room metrics; cleared on read. */
  sendsCount = 0;
  sendsNs = 0;
  /** Flush counter -- the tick frame's per-conn drown gate samples
   *  buffered every 4th flush (~200ms) instead of every send: the
   *  native getBufferedAmount read was inside the measured ~26us
   *  ws.send cost, and the 5s drown window doesn't need 20Hz reads. */
  private flushCount = 0;
  flushOutboxes(): void {
    this.collecting = false;
    this.flushCount += 1;
    for (const [pid, q] of this.outbox) {
      // Persistent queue -- the array survives the flush (length reset),
      // so a steady fleet allocates zero outbox objects per tick.
      if (q.length > 0) {
        const ws = this.connections.get(pid);
        if (ws && ws.readyState === 1 && ((this.flushCount & 3) !== 0 || this.drownCheck(pid, ws) === 'ok')) {
          const t0 = process.hrtime.bigint();
          const status = ws.send(q.length === 1 ? q[0]! : encodeBatch(q, this.batchScratch));
          this.sendsNs += Number(process.hrtime.bigint() - t0);
          this.sendsCount += 1;
          if (status === 0) {
            this.reliableDropped += 1;
            this.onReliableDropped?.(pid);
            try { ws.close(1011, 'reliable drop'); } catch { /* already closing */ }
          }
        }
        q.length = 0;
      }
    }
  }

  /** Register→intro-gate-open span -- how long the join burst takes to
   *  drain under load (the "playable" point, not just first gameState). */
  private introAt = new Map<string, number>();
  /** Fires once per seat when the intro gate opens; room folds it into
   *  health counters. */
  onIntroDrained?: (playerId: string, ms: number) => void;

  private connections: Map<string, ServerWebSocket<WebSocketData>> = new Map();
  /** Pids whose post-join outbox has drained once -- the tick intro gate
   *  holds frames until the join burst clears, not just on first seat. */
  private tickDrained: Set<string> = new Set();

  /** Inbound flood control (Bun 1.4 ws.pause): a tripped rate-limit
   *  socket stops dispatching entirely -- the kernel buffers its frames,
   *  zero parse/validate cost for the window. resume() fires on the
   *  live check only; a socket that died mid-pause is simply gone. */
  private floodTimers = new Map<string, ReturnType<typeof setTimeout>>();
  floodPause(playerId: string, ms: number): void {
    const ws = this.connections.get(playerId);
    if (!ws) {return;}
    // Bun ≥1.4 runtime API -- the installed bun-types predates it, and
    // adapters/test fakes may not carry it at all.
    const sock = ws as unknown as { pause?: () => void; resume?: () => void };
    const resume = sock.resume?.bind(sock);
    if (!sock.pause || !resume) {return;}
    sock.pause();
    const prev = this.floodTimers.get(playerId);
    if (prev) {clearTimeout(prev);}
    this.floodTimers.set(playerId, setTimeout((): void => {
      this.floodTimers.delete(playerId);
      if (ws.readyState === 1) {resume();}
    }, ms).unref());
  }

  // Offset cursor (Socket.IO connection-state-recovery shape): every
  // reliable JSON frame carries a room-scoped `ev` seq, and the last N
  // frames sit in a journal. A reclaim presents the last seq it processed
  // and we replay only what its dead socket missed -- cheaper than a blind
  // resnapshot and it preserves event causality. Binary lanes (ticks,
  // ball segments) skip the journal: ticks are drop-safe and the reclaim's
  // gameState+ballRoster already reseeds ball truth.
  private outSeq = 0;
  /** JSON frames AND opt-in binary events share the journal + one ev seq
   *  space -- replay preserves causal order regardless of lane. */
  private journal: { seq: number; data: string | Uint8Array; only?: string; exclude?: string; volatile?: boolean; ttl?: number; at: number }[] = [];
  static readonly JOURNAL_MAX = 2048;
  /** splice(0,1) per push at saturation memmoves the whole journal every
   *  frame -- evict in chunks so the copy amortizes. Cap is a steady-state
   *  target, not a hard bound; replay ordering and oldest-seq lookup are
   *  unchanged. */
  static readonly JOURNAL_EVICT_CHUNK = 128;
  /** Frames evicted from the journal before any in-flight reclaim could
   *  replay them -- a gap the reclaiming client can never see again, so a
   *  nonzero count means a silent desync happened. The room folds this
   *  into its health counters; the owner can bump a tag on each wrap. */
  journalDropped = 0;
  onJournalWrap?: (dropped: number) => void;
  /** Frames a reclaim asked for that were already evicted -- the client
   *  gets gameState truth but loses event history (kills, flag edges,
   *  chat). Counted so an undersized journal is visible, not silent. */
  reclaimGap = 0;
  onReclaimGap?: (playerId: string, missed: number) => void;
  /** Sockets closed by the drown drain -- room health counts each via the
   *  callback so a pathological client shows up in the counters, not
   *  just the close log. */
  onDrowned?: (playerId: string) => void;
  /** Reliable frames uWS refused outright (send()===0, past the 16MB
   *  backpressureLimit). Rare under our own 4MB drown cap, but a real
   *  silent-loss channel: the client stays connected while truth
   *  evaporates. Counted like drowned sockets. */
  reliableDropped = 0;
  onReliableDropped?: (playerId: string) => void;

  /** Raw buffered-amount sample per reliable send -- the room folds it
   *  into a bufMax gauge. Drown only fires past the cap; this surfaces
   *  the approach (a socket drowning for seconds before it dies). */
  onBuffered?: (playerId: string, bytes: number) => void;

  /** Reliable-lane sends all funnel through here on the way to a socket.
   *  A transient spike (reclaim replay burst) just starts the clock and
   *  drains under the hysteresis; a dead reader holds the mark and gets
   *  closed -- skip sending into a socket already past the mark so the
   *  buffered byte count doesn't balloon while the clock runs. */
  private drownCheck(playerId: string, ws: ServerWebSocket<WebSocketData>): 'ok' | 'drowned' {
    const buffered = (ws as unknown as { getBufferedAmount?(): number }).getBufferedAmount?.() ?? 0;
    // Sockets without a data slot (test mocks) can't carry the mark --
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
      return 'ok'; // first sighting -- could be the reclaim burst
    }
    if (wallNow() - since < SLOW_FOR_MS) {return 'drowned';}
    logger.warn('closing drowned socket', { playerId, buffered, slowMs: wallNow() - since });
    this.onDrowned?.(playerId);
    try { ws.close(1011, 'slow client'); } catch { /* already closing */ }
    return 'drowned';
  }

  /** Reliable-lane send with status check. `send()` returns >0 sent,
   *  -1 queued under backpressure, 0 DROPPED -- and a dropped reliable
   *  frame is the exact "pickup/damage silently missing" bug: the
   *  socket stays open while events vanish, and the journal only
   *  replays on reclaim. A drop means this socket can't be trusted:
   *  close it so the client reclaims and replays honestly. */
  private sendReliable(playerId: string, ws: ServerWebSocket<WebSocketData>, data: string | Uint8Array, kind?: string): void {
    wireTx(playerId, typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength,
      kind ?? (typeof data === 'string' ? `j:${/^.{0,30}?"type":"?([a-zA-Z]+)/.exec(data)?.[1] ?? '?'}` : BIN_KIND[data[1]!]!));
    const status = ws.send(data);
    if (status === 0) {
      this.reliableDropped += 1;
      this.onReliableDropped?.(playerId);
      logger.warn('reliable frame dropped by transport -- closing to force reclaim', { playerId });
      try { ws.close(1011, 'reliable drop'); } catch { /* already closing */ }
    }
  }

  private frame(msg: ServerMessage, only?: string, exclude?: string): { data: string; kind: string } {
    this.outSeq += 1;
    const seq = this.outSeq;
    // Stamp in place -- every call site passes a fresh literal, so the
    // Object.assign({msg, ev}) clone was a throwaway per send (~1-2K/s).
    (msg as { ev?: number }).ev = seq;
    const data = JSON.stringify(msg);
    if (!NO_JOURNAL_TYPES.has((msg as { type: string }).type)) {
      const volatile_ = VOLATILE_TYPES.has((msg as { type: string }).type);
      const ttl = volatile_ ? VOLATILE_TTL_MS : COSMETIC_TTL.get((msg as { type: string }).type);
      this.journal.push({ seq, data, only, exclude, volatile: volatile_, ttl, at: wallNow() });
      if (this.journal.length > ConnectionManager.JOURNAL_MAX + ConnectionManager.JOURNAL_EVICT_CHUNK) {
        const n = this.journal.length - ConnectionManager.JOURNAL_MAX;
        this.journal.splice(0, n);
        this.journalDropped += n;
        this.onJournalWrap?.(n);
      }
    }
    return { data, kind: `j:${(msg as { type: string }).type}` };
  }

  /** Binary events opt INTO the journal at call time (playerHit etc --
   *  they're the combat stream a reclaim must replay; ticks/ball segs
   *  stay drop-safe and skip). Shares the ev seq space so replay order
   *  matches live order. */
  private journalBinary(data: Uint8Array, only?: string, exclude?: string, volatile_ = false): void {
    this.outSeq += 1;
    // slice() -- emit-time frames live in the shared evScratch ring and
    // recycle after ~128 encodes; the journal retains until replay.
    this.journal.push({ seq: this.outSeq, data: data.slice(), only, exclude, volatile: volatile_, ttl: volatile_ ? VOLATILE_TTL_MS : undefined, at: wallNow() });
    if (this.journal.length > ConnectionManager.JOURNAL_MAX + ConnectionManager.JOURNAL_EVICT_CHUNK) {
      const n = this.journal.length - ConnectionManager.JOURNAL_MAX;
      this.journal.splice(0, n);
      this.journalDropped += n;
      this.onJournalWrap?.(n);
    }
  }

  /** Reclaim replay -- frames addressed to everyone or to this player that
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
    // Cork the burst: replay fires up to ~1024 sends back-to-back --
    // batching them costs one flush instead of one syscall each.
    // (Test mocks have no cork -- flush unbatched there.)
    const stale = (e: (typeof this.journal)[number]): boolean =>
      e.ttl !== undefined && now - e.at > e.ttl;
    const eligible = (e: (typeof this.journal)[number]): boolean =>
      e.seq > fromSeq && !stale(e) &&
      (e.only === undefined || e.only === playerId) && e.exclude !== playerId;
    const pump = (): void => {
      for (const e of this.journal) {
        if (e.seq <= fromSeq) {continue;}
        if (stale(e)) {skippedStale += 1; continue;}
        if (!eligible(e)) {continue;}
        // Replay rides the same backpressure path as live sends -- a
        // drowning socket gets its clock started (or closed) instead of
        // being re-flooded and silently dropping frames.
        if (this.drownCheck(playerId, ws) !== 'ok') {
          // The un-replayed tail was eligible for this recipient but never
          // sent -- count it as a reclaim gap or the client's seq watermark
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
    this.introAt.set(playerId, wallNow());
    this.tickDrained.delete(playerId); // joins re-arm the intro hold
    this.heldPhase.delete(playerId);   // ...and its grace count
    if (this.topic && ConnectionManager.publishFns.size > 0 && typeof ws.subscribe === 'function') {
      ws.subscribe(this.topic);
      this.pubbed.add(playerId);
    }
    logger.info(`Connection registered`, { playerId, total: this.connections.size });
  }

  unregister(playerId: string): void {
    const ws = this.connections.get(playerId);
    if (ws) {
      this.connections.delete(playerId);
      this.introAt.delete(playerId);
      this.tickDrained.delete(playerId);
      this.pubbed.delete(playerId);
      this.drownSweepAt.delete(playerId);
      this.shedPhase.delete(playerId);
      this.heldPhase.delete(playerId);
      this.outbox.delete(playerId);
      this.frameArenas.delete(playerId);
      this.bufSampleAt.delete(playerId);
      this.bufSampleVal.delete(playerId);
      const ft = this.floodTimers.get(playerId);
      if (ft) {clearTimeout(ft); this.floodTimers.delete(playerId);}
      if (this.topic && typeof ws.unsubscribe === 'function') {ws.unsubscribe(this.topic);}
      wireClose(playerId); // drop the /wire conn entry -- ghosts otherwise list forever
      ConnectionManager.onUnreg?.(playerId);
      logger.info(`Connection unregistered`, { playerId, total: this.connections.size });
    }
  }

  sendToPlayer(playerId: string, msg: ServerMessage): void {
    // Journal BEFORE delivery -- a frame aimed at a dead/grace socket is
    // exactly what reclaim replay must find later.
    const f = this.frame(msg, playerId);
    if (this.collecting || (this.ticksRunning && VOLATILE_TYPES.has((msg as { type: string }).type))) {
      this.push(playerId, encodeWireJson(f.data));
      wireTx(playerId, f.data.length, f.kind);
      return;
    }
    const ws = this.connections.get(playerId);
    if (WIRESPY && (msg as { type?: string }).type === 'ping') {
      logger.warn('wirespy pingTick', { playerId, wsFound: Boolean(ws), rs: ws?.readyState });
    }
    if (ws && ws.readyState === 1 && this.drownCheck(playerId, ws) === 'ok') {
      this.sendReliable(playerId, ws, f.data, f.kind);
    }
  }

  /** Binary hot-path frames (tickUpdate) -- no JSON.stringify. On WS
   *  this is the single TCP stream; on WT the adapter routes ticks to
   *  stream-2 (reliable, HoL-isolated) once the binLane caps handshake
   *  lands -- measured ~33% seq loss on the QUIC datagram lane makes it
   *  unfit as the primary state lane (see _docs/2026-10-18_NETCODE_DEEP_DIVE_3). */
  /** Returns 'sent' | 'held' | 'backlogged' | 'sparse' | 'gone' -- 'held'
   *  is the intro gate (counted separately, not a loss); 'backlogged' is
   *  a real shed; 'sparse' is the 1-in-SHED_KEEPALIVE keepalive that still
   *  rode through on a backlogged socket (sent, but the socket is
   *  degraded); a closing socket isn't a dropped frame. */
  sendBinaryToPlayer(playerId: string, data: Uint8Array): 'sent' | 'held' | 'backlogged' | 'sparse' | 'gone' {
    const ws = this.connections.get(playerId);
    if (!ws || ws.readyState !== 1) {return 'gone';}
    const buffered = this.bufferedOf(playerId, ws);
    // UDP-bound session: volatile tick frames ride the datagram lane
    // outright -- before the outbox/collect path so they never queue
    // behind the reliable batch.
    if (ConnectionManager.udpSend?.(playerId, data) === true) {return 'sent';}
    if (!this.tickDrained.has(playerId)) {
      if (buffered > INTRO_DRAIN_FLOOR) {
        const h = (this.heldPhase.get(playerId) ?? 0) + 1;
        this.heldPhase.set(playerId, h);
        // Held PAST the grace isn't a fresh join catching up -- it never
        // drains at all. Pinning it at 'held' starves the client of every
        // tick AND never starts the drown clock (the bigSoak alive-but-
        // stalled signature): degrade it to the sparse lane like a backlog.
        if (h > HELD_GRACE_TICKS) {return this.sparseOrShed(playerId, ws, data);}
        return 'held';
      }
      this.heldPhase.delete(playerId);
      this.tickDrained.add(playerId); // first clean sample -- gate opens
      const introT0 = this.introAt.get(playerId);
      if (introT0 !== undefined) {this.introAt.delete(playerId); this.onIntroDrained?.(playerId, wallNow() - introT0);}
    }
    if (buffered > MAX_TICK_BACKLOG) {return this.sparseOrShed(playerId, ws, data);}
    this.strained.delete(playerId); // clean sample drains the marker
    wireTx(playerId, data.byteLength, BIN_KIND[data[1]!]!);
    if (this.collecting) {this.push(playerId, data); return 'sent';}
    ws.send(data);
    return 'sent';
  }

  /** Over-cap lane: SHED_KEEPALIVE-1 of N frames shed, the Nth rides
   *  through at degrade cadence. Backlogged sockets ALSO feed the drown
   *  clock -- the cap sheds frames but a reader that never drains must
   *  still be closed, or a tick-only client lingers below DROWN_BYTES. */
  private sparseOrShed(playerId: string, ws: ServerWebSocket<WebSocketData>, data: Uint8Array): 'backlogged' | 'sparse' {
    this.strained.add(playerId); // fanout reads this: strained conns get a halved record cap
    this.drownCheck(playerId, ws);
    const n = (this.shedPhase.get(playerId) ?? 0) + 1;
    if (n < SHED_KEEPALIVE) {this.shedPhase.set(playerId, n); return 'backlogged';}
    this.shedPhase.set(playerId, 0);
    wireTx(playerId, data.byteLength, BIN_KIND[data[1]!]!);
    if (this.collecting) {this.push(playerId, data);} else {ws.send(data);}
    return 'sparse';
  }

  /** Correctness-critical binary (ball segments) -- always the reliable
   *  lane. A dropped segment is a resync the client free-runs blind for
   *  ~1.2s, which is exactly the rubberband pattern; a dropped tick frame
   *  is just interpolation noise. At ~50B × ~10/s per ball this is cheap.
   *  Still rides the drown check: a stalled reader otherwise queues
   *  segments forever and -- since ticks ride the capped lane -- a
   *  binary-only client would never even start the drain clock. The
   *  reclaim's ballRoster reseeds ball truth, so the skip is honest. */
  /** Pubbed sockets skip per-conn sends, but the drown clock still needs
   *  a buffered sample -- once per DROWN_SWEEP_MS per conn, not per frame
   *  (a native getBufferedAmount per broadcast×conn was a hot remnant). */
  private drownSweepAt = new Map<string, number>();
  /** getBufferedAmount is a native call -- sampling it per send frame was
   *  a cpuprofile line at 1k conns. Cached while `collecting` (the batched
   *  tick window, ≤50ms -- the shed/held gates tolerate that staleness;
   *  outside the window every read is fresh, per the intro-gate tests). */
  private bufSampleAt = new Map<string, number>();
  private bufSampleVal = new Map<string, number>();
  private bufferedOf(pid: string, ws: ServerWebSocket<WebSocketData>): number {
    if (!this.collecting) {
      return (ws as unknown as { getBufferedAmount?(): number }).getBufferedAmount?.() ?? 0;
    }
    const now = wallNow();
    if (now - (this.bufSampleAt.get(pid) ?? -1e12) < 50) {return this.bufSampleVal.get(pid) ?? 0;}
    const v = (ws as unknown as { getBufferedAmount?(): number }).getBufferedAmount?.() ?? 0;
    this.bufSampleAt.set(pid, now);
    this.bufSampleVal.set(pid, v);
    return v;
  }
  /** Per-conn shed phase -- counts backlogged ticks so every SHED_KEEPALIVE-th
   *  still rides through (sparse keepalive); reset on unregister. */
  private shedPhase = new Map<string, number>();
  /** Conns currently over the tick backlog — set in sparseOrShed,
   *  cleared on the first clean sample. The fanout drops these seats
   *  to a halved record cap: half the encode work and egress land on
   *  exactly the links that can't keep up. */
  readonly strained = new Set<string>();
  isStrained(playerId: string): boolean { return this.strained.has(playerId); }
  /** Per-conn held-gate streak -- the intro burst's grace is counted in
   *  calls (~ticks), not wall time; a conn that drains resets to zero. */
  private heldPhase = new Map<string, number>();
  private static DROWN_SWEEP_MS = 250;
  private drownSweep(pid: string, ws: ServerWebSocket<WebSocketData>): void {
    const now = wallNow();
    if (now - (this.drownSweepAt.get(pid) ?? 0) < ConnectionManager.DROWN_SWEEP_MS) {return;}
    this.drownSweepAt.set(pid, now);
    this.drownCheck(pid, ws);
  }

  broadcastBinaryReliable(data: Uint8Array, journaled: boolean | 'volatile' = false, exclude?: string): void {
    const kind = BIN_KIND[data[1]!]!;
    if (journaled) {this.journalBinary(data, undefined, exclude, journaled === 'volatile');} // combat events replay on reclaim -- 'volatile' carries the same 3s staleness window the JSON version had
    if (this.collecting || (this.ticksRunning && journaled === 'volatile')) {
      // Ring views get one shared copy for the whole broadcast -- push()
      // would otherwise slice the same bytes once per recipient.
      const owned = isEvScratch(data) ? data.slice() : data;
      for (const pid of this.connections.keys()) {
        if (pid === exclude) {continue;}
        this.push(pid, owned); wireTx(pid, data.byteLength, kind);
      }
      return;
    }
    // publish() can't exclude a socket -- an excluded broadcast pays the
    // per-conn path like the JSON version does.
    if (exclude === undefined && ConnectionManager.publishFns.size > 0 && this.topic && this.pubbed.size > 0) {
      for (const pub of ConnectionManager.publishFns) {pub(this.topic, data);}
    }
    this.connections.forEach((ws, pid): void => {
      if (pid === exclude) {return;}
      if (exclude === undefined && this.pubbed.has(pid)) {
        // Published -- keep the drown clock fed anyway: a dead reader on
        // the topic lane queues the same bytes without a per-conn drop
        // signal to catch it early.
        wireTx(pid, data.byteLength, kind);
        this.drownSweep(pid, ws);
        return;
      }
      if (ws.readyState === 1 && this.drownCheck(pid, ws) === 'ok') {this.sendReliable(pid, ws, data, kind);}
    });
  }

  /** Single-recipient reliable binary (knockback etc) -- journalled with
   *  `only` so a reclaim replays it to the victim alone. */
  sendBinToPlayerReliable(playerId: string, data: Uint8Array, journaled: boolean | 'volatile' = false): void {
    if (journaled) {this.journalBinary(data, playerId, undefined, journaled === 'volatile');}
    if (this.collecting || (this.ticksRunning && journaled === 'volatile')) {this.push(playerId, data); wireTx(playerId, data.byteLength, BIN_KIND[data[1]!]!); return;}
    const ws = this.connections.get(playerId);
    if (ws && ws.readyState === 1 && this.drownCheck(playerId, ws) === 'ok') {this.sendReliable(playerId, ws, data, BIN_KIND[data[1]!]!);}
  }

  broadcast(msg: ServerMessage, excludePlayerId?: string): void {
    const f = this.frame(msg, undefined, excludePlayerId);
    if (this.collecting || (this.ticksRunning && VOLATILE_TYPES.has((msg as { type: string }).type))) {
      const bin = encodeWireJson(f.data);
      for (const pid of this.connections.keys()) {
        if (pid === excludePlayerId) {continue;}
        this.push(pid, bin);
        wireTx(pid, f.data.length, f.kind);
      }
      return;
    }
    if (WIRESPY && (msg as { type?: string }).type === 'projectileCreated') {
      logger.warn('wirespy broadcast', { type: 'projectileCreated', conns: [...this.connections.keys()] });
    }
    if (ConnectionManager.publishFns.size > 0 && this.topic && excludePlayerId === undefined && this.pubbed.size > 0) {
      for (const pub of ConnectionManager.publishFns) {pub(this.topic, f.data);}
      this.connections.forEach((ws, pid): void => {
        if (this.pubbed.has(pid)) {
          wireTx(pid, f.data.length, f.kind);
          this.drownSweep(pid, ws);
          return;
        }
        if (ws.readyState === 1 && this.drownCheck(pid, ws) === 'ok') {this.sendReliable(pid, ws, f.data, f.kind);}
      });
      return;
    }
    this.connections.forEach((ws, pid): void => {
      if (excludePlayerId !== undefined && pid === excludePlayerId) {return;}
      if (ws.readyState === 1 && this.drownCheck(pid, ws) === 'ok') {
        this.sendReliable(pid, ws, f.data, f.kind);
      }
    });
  }

  /** Intro-gate probe -- false while a fresh seat's outbox still holds
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
   *  the client WHY the session ended -- 1001 'going away' reads as
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
