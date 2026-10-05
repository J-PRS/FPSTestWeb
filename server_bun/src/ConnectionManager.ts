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
const VOLATILE_TTL_MS = 3000;

export class ConnectionManager {
  private connections: Map<string, ServerWebSocket<WebSocketData>> = new Map();

  // Offset cursor (Socket.IO connection-state-recovery shape): every
  // reliable JSON frame carries a room-scoped `ev` seq, and the last N
  // frames sit in a journal. A reclaim presents the last seq it processed
  // and we replay only what its dead socket missed — cheaper than a blind
  // resnapshot and it preserves event causality. Binary lanes (ticks,
  // ball segments) skip the journal: ticks are drop-safe and the reclaim's
  // gameState+ballRoster already reseeds ball truth.
  private outSeq = 0;
  private journal: { seq: number; data: string; only?: string; exclude?: string; volatile?: boolean; at: number }[] = [];
  private static readonly JOURNAL_MAX = 1024;
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

  /** Reliable-lane sends all funnel through here on the way to a socket.
   *  A transient spike (reclaim replay burst) just starts the clock and
   *  drains under the hysteresis; a dead reader holds the mark and gets
   *  closed — skip sending into a socket already past the mark so the
   *  buffered byte count doesn't balloon while the clock runs. */
  private drownCheck(playerId: string, ws: ServerWebSocket<WebSocketData>): 'ok' | 'drowned' {
    const buffered = (ws as unknown as { getBufferedAmount?(): number }).getBufferedAmount?.() ?? 0;
    // Sockets without a data slot (test mocks) can't carry the mark —
    // buffered is also 0 there, so there's nothing to track anyway.
    if (!ws.data) return 'ok';
    if (buffered < DROWN_BYTES) {
      ws.data.slowSince = undefined;
      return 'ok';
    }
    const since = ws.data.slowSince;
    if (since === undefined) {
      ws.data.slowSince = wallNow();
      return 'ok'; // first sighting — could be the reclaim burst
    }
    if (wallNow() - since < SLOW_FOR_MS) return 'drowned';
    logger.warn('closing drowned socket', { playerId, buffered, slowMs: wallNow() - since });
    this.onDrowned?.(playerId);
    try { ws.close(1011, 'slow client'); } catch { /* already closing */ }
    return 'drowned';
  }

  private frame(msg: ServerMessage, only?: string, exclude?: string): string {
    const seq = ++this.outSeq;
    const data = JSON.stringify({ ...(msg as object), ev: seq });
    const volatile_ = VOLATILE_TYPES.has((msg as { type: string }).type);
    this.journal.push({ seq, data, only, exclude, volatile: volatile_, at: wallNow() });
    if (this.journal.length > ConnectionManager.JOURNAL_MAX) {
      const n = this.journal.length - ConnectionManager.JOURNAL_MAX;
      this.journal.splice(0, n);
      this.journalDropped += n;
      this.onJournalWrap?.(n);
    }
    return data;
  }

  /** Reclaim replay — frames addressed to everyone or to this player that
   *  arrived after their last processed seq. Runs before the handshake
   *  reply so gameState remains the final word on truth. */
  replayTo(playerId: string, ws: ServerWebSocket<WebSocketData>, fromSeq: number): number {
    const now = wallNow();
    let n = 0, skippedStale = 0;
    const oldest = this.journal.length ? this.journal[0]!.seq : this.outSeq + 1;
    const missed = oldest - fromSeq - 1;
    if (missed > 0) {
      this.reclaimGap += missed;
      this.onReclaimGap?.(playerId, missed);
    }
    for (const e of this.journal) {
      if (e.seq <= fromSeq) continue;
      if (e.volatile && now - e.at > VOLATILE_TTL_MS) { skippedStale++; continue; }
      if (e.only !== undefined && e.only !== playerId) continue;
      if (e.exclude === playerId) continue;
      ws.send(e.data);
      n++;
    }
    if (n > 0 || skippedStale > 0) logger.info('reclaim replay', { playerId, fromSeq, replayed: n, skippedStale });
    return n;
  }

  register(playerId: string, ws: ServerWebSocket<WebSocketData>): void {
    this.connections.set(playerId, ws);
    logger.info(`Connection registered`, { playerId, total: this.connections.size });
  }

  unregister(playerId: string): void {
    const ws = this.connections.get(playerId);
    if (ws) {
      this.connections.delete(playerId);
      logger.info(`Connection unregistered`, { playerId, total: this.connections.size });
    }
  }

  sendToPlayer(playerId: string, msg: ServerMessage): void {
    // Journal BEFORE delivery — a frame aimed at a dead/grace socket is
    // exactly what reclaim replay must find later.
    const data = this.frame(msg, playerId);
    const ws = this.connections.get(playerId);
    if (ws && ws.readyState === 1 && this.drownCheck(playerId, ws) === 'ok') {
      ws.send(data);
    }
  }

  /** Binary hot-path frames (tickUpdate) — no JSON.stringify. Rides the
   *  reliable lane on every transport: measured WT datagram loss on
   *  loopback was ~47%, which played as remote stutter + a bogus loss
   *  reading, and the datagram lane buys nothing when it's dropping half
   *  the frames anyway. Revisit if the QUIC lane proves reliable. */
  /** Returns 'sent' | 'backlogged' | 'gone' — the caller only counts
   *  'backlogged' as loss; a closing socket isn't a dropped frame. */
  sendBinaryToPlayer(playerId: string, data: Uint8Array): 'sent' | 'backlogged' | 'gone' {
    const ws = this.connections.get(playerId);
    if (!ws || ws.readyState !== 1) return 'gone';
    const buffered = (ws as unknown as { getBufferedAmount?(): number }).getBufferedAmount?.() ?? 0;
    if (buffered > MAX_TICK_BACKLOG) return 'backlogged';
    ws.send(data);
    return 'sent';
  }

  /** Correctness-critical binary (ball segments) — always the reliable
   *  lane. A dropped segment is a resync the client free-runs blind for
   *  ~1.2s, which is exactly the rubberband pattern; a dropped tick frame
   *  is just interpolation noise. At ~50B × ~10/s per ball this is cheap. */
  broadcastBinaryReliable(data: Uint8Array): void {
    this.connections.forEach((ws) => {
      if (ws.readyState === 1) ws.send(data);
    });
  }

  broadcast(msg: ServerMessage, excludePlayerId?: string): void {
    const data = this.frame(msg, undefined, excludePlayerId);
    this.connections.forEach((ws, pid) => {
      if (excludePlayerId !== undefined && pid === excludePlayerId) return;
      if (ws.readyState === 1 && this.drownCheck(pid, ws) === 'ok') {
        ws.send(data);
      }
    });
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
    this.connections.forEach((ws) => {
      if (ws.readyState === 1) {
        try { ws.close(code, reason); } catch { /* already closing */ }
      }
    });
  }
}
