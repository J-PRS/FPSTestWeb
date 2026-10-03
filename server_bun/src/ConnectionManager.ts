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

  private frame(msg: ServerMessage, only?: string, exclude?: string): string {
    const seq = ++this.outSeq;
    const data = JSON.stringify({ ...(msg as object), ev: seq });
    const volatile_ = VOLATILE_TYPES.has((msg as { type: string }).type);
    this.journal.push({ seq, data, only, exclude, volatile: volatile_, at: wallNow() });
    if (this.journal.length > ConnectionManager.JOURNAL_MAX) {
      this.journal.splice(0, this.journal.length - ConnectionManager.JOURNAL_MAX);
    }
    return data;
  }

  /** Reclaim replay — frames addressed to everyone or to this player that
   *  arrived after their last processed seq. Runs before the handshake
   *  reply so gameState remains the final word on truth. */
  replayTo(playerId: string, ws: ServerWebSocket<WebSocketData>, fromSeq: number): number {
    const now = wallNow();
    let n = 0, skippedStale = 0;
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
    if (ws && ws.readyState === 1) {
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
      if (ws.readyState === 1) {
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
}
