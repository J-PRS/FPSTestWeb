/**
 * TickFanout — the per-tick record family for TickLoop: which players
 * earn a record this tick (skip/reap/suppress), the server-owned health
 * and charge echoes that ride along, and the distance-tiered fanout to
 * each recipient. TickLoop owns the timers/metrics rollup; this owns
 * "what leaves the room this tick".
 */
import type { Room } from './Room.ts';
import { encodeTickPlayer, encodeTickFrame } from '../../shared/wire.ts';
import { STATUS } from '../../shared/status.ts';
import { lgChargeAt } from '../../shared/combat.ts';
import { logger } from './logger.ts';
import type { PlayerState } from './types.ts';
import { healPerTick, recordSuppressed, type TickRecord } from './tickHelpers.ts';
import { CONFIG } from './config.ts';
import { healPool } from './healPool.ts';

type Players = ReturnType<Room['players']['getAllPlayers']>;

/** Counters the loop's metrics rollup reads — shared object so a second
 *  writer (this family) lands in the same rollup window. */
export interface FanoutMetrics {
  recordsBuilt: number;
  recordsSuppressed: number;
  recordsIdleReaped: number;
  recordsSent: number;
  recordsTierSkipped: number;
  bytesSent: number;
  tickFramesDropped: number;
}

export class TickFanout {
  /** Scratch array: same array every tick, zero allocation on the hot
   *  path — encodeTickFrame consumes it before the next recipient
   *  iterates. */
  private readonly scratchOthers: Uint8Array[] = [];

  private static readonly IDLE_KICK_MS = CONFIG.idleKickMs; // silent >60s → remove

  constructor(
    private readonly metrics: FanoutMetrics,
    private readonly onRemove: (room: Room, playerId: string, reason: string) => void,
  ) {}

  buildRecords(room: Room, players: Players, now: number): TickRecord[] {
    const records: TickRecord[] = [];
    for (const [playerId, p] of players) {
      if (this.skipRecord(room, playerId, p, now)) continue;
      this.tickServerHeals(room, playerId, p, now);
      this.tickChargeEcho(room, playerId, p, now);
      const forceSend = now < p.forceSendUntil;
      const lastSent = room.lastSentPositions.get(playerId);
      const sheep = room.bots.sheepOf(playerId);
      if (lastSent && !forceSend && recordSuppressed(p, lastSent, now, sheep)) {
        this.metrics.recordsSuppressed++;
        continue; // Skip — within extrapolation tolerance
      }
      // Mutate the snapshot in place — a fresh object per record per tick
      // was the last steady-state alloc in this loop.
      let snap = lastSent;
      if (!snap) {
        snap = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, hp: 0, dead: false, ski: 0, status: 0, sheep: 0, t: 0 };
        room.lastSentPositions.set(playerId, snap);
      }
      snap.x = p.position.x; snap.y = p.position.y; snap.z = p.position.z;
      snap.vx = p.velocity.x; snap.vy = p.velocity.y; snap.vz = p.velocity.z;
      snap.yaw = p.rotation.yaw; snap.pitch = p.rotation.pitch;
      snap.hp = p.health; snap.dead = p.isDead; snap.ski = p.skiing;
      // Buff bits are server-owned (stripped from client claims at
      // inputMove) so they must be OR-ed on here, not read off p.status.
      snap.status = p.status
        | (now < p.regenUntil ? STATUS.REGEN : 0)
        | (now < p.ddUntil ? STATUS.DD : 0)
        | (lgChargeAt(p.charge, p.chargeT, now / 1000) > 0 ? STATUS.CHARGED : 0);
      snap.sheep = sheep;
      snap.t = now;

      records.push({
        playerId,
        data: encodeTickPlayer({
          playerId,
          position: p.position,
          rotation: p.rotation,
          velocity: p.velocity,
          health: p.health,
          isDead: p.isDead,
          // Only advertise a proven ping — stale heartbeats above would
          // otherwise broadcast the default 0 for ghosts that never
          // reported (renders them with a bogus "0ms" ping).
          ping: p.ping > 0 ? p.ping : undefined,
          ski: p.skiing,
          status: snap.status,
          sheep,
        }),
        pos: p.position,
        force: forceSend,
      });
      this.metrics.recordsBuilt++;
    }
    return records;
  }

  /** Every reason a player contributes no record this tick, in order:
   *  grace entries (owned by their removal timeout — reaping here would
   *  double playerLeft), idle reap (before the ghost check or unreported
   *  dead sockets linger forever), humans that never reported (menu/lobby —
   *  their record renders a frozen ghost at the spawn default; bots exempt
   *  since the sim writes their position), and the stale heartbeat —
   *  silent sockets get a 0.5Hz record so clients' stored state (health,
   *  isDead) still converges; gated on THAT player's lastSent, not a shared
   *  clock — a shared timestamp meant only the first stale player in map
   *  order ever heartbeat. */
  private skipRecord(room: Room, playerId: string, p: PlayerState, now: number): boolean {
    if (room.disconnected.has(playerId)) return true;
    const silenceMs = now - p.lastSeen;
    // Idle reap FIRST: a menu-sitter's dead socket must still be collected
    // — checking hasReceivedPosition before this left unreported ghosts
    // sitting in the roster forever.
    if (this.reapIdle(room, playerId, p, silenceMs)) return true;
    if (!p.isBot && !p.hasReceivedPosition) return true;
    const lastSent = room.lastSentPositions.get(playerId);
    return silenceMs > 5000 && lastSent !== undefined && now - lastSent.t < 2000;
  }

  /** Human silence past IDLE_KICK_MS gets reaped — close the live socket
   *  (onClose runs the grace path) or remove directly when it's already
   *  dead. Returns true when the player was reaped. */
  private reapIdle(room: Room, playerId: string, p: PlayerState, silenceMs: number): boolean {
    if (p.isBot || silenceMs <= TickFanout.IDLE_KICK_MS) return false;
    const ws = room.socketOf(playerId);
    if (ws && ws.readyState === 1) {
      ws.close(1000, 'idle'); // triggers onClose → grace cleanup
    } else {
      this.onRemove(room, playerId, 'idle');
    }
    logger.info('Idle player removed', { playerId, silenceMs });
    this.metrics.recordsIdleReaped++;
    return true;
  }

  /** Health channels the server owns: medkit channel (flag), regenerator
   *  perk (passive), regen powerup (timed). All cap at the perk max.
   *  Server-owned heals never reach the owner — self is excluded from
   *  tickUpdate — so a low-rate yourHealth echo keeps their hp from
   *  drifting until the next discrete event. */
  private tickServerHeals(room: Room, playerId: string, p: PlayerState, now: number): void {
    const heal = healPerTick(p, now);
    if (heal <= 0) return;
    healPool(p, heal);
    // Capping out always echoes — the channel ends here, so the final
    // converged hp would otherwise wait on the next discrete event.
    if (now - p.healthEchoAt >= 500 || p.health >= p.maxHealth) {
      p.healthEchoAt = now;
      room.connections.sendToPlayer(playerId, { type: 'yourHealth', health: p.health });
    }
  }

  /** The carrier is the one client that can't see the CHARGED status bit
   *  (own records are excluded from fanout) — echo their decayed bank at
   *  0.5Hz so a walking bomb can hear itself crackle. A final 0 lands the
   *  moment the bank drains so the warning doesn't linger. */
  private tickChargeEcho(room: Room, playerId: string, p: PlayerState, now: number): void {
    const acc = lgChargeAt(p.charge, p.chargeT, now / 1000);
    const live = acc > 0.5;
    if (!live && p.chargeEchoed <= 0) return;
    if (live && now - p.chargeEchoAt < 500) return;
    p.chargeEchoAt = now;
    p.chargeEchoed = live ? acc : 0;
    room.connections.sendToPlayer(playerId, { type: 'yourCharge', charge: p.chargeEchoed });
  }

  /** Interest management: distance-tiered update rate per recipient.
   *  <150m (engagement range) every tick · <400m half rate · beyond 1/4.
   *  Hits/kills travel on reliable events, so stale far ghosts only lose
   *  smoothness on targets that are visually specks anyway. */
  fanoutRecords(room: Room, players: Players, records: TickRecord[]): void {
    const seq = room.tickSeq;
    for (const [recipientId, rp] of players) {
      // Grace-period entries have no socket — record filtering for them
      // is wasted work
      if (room.disconnected.has(recipientId)) continue;
      const rx = rp.position.x, ry = rp.position.y, rz = rp.position.z;
      const others = this.scratchOthers;
      others.length = 0;
      for (const r of records) {
        if (r.playerId === recipientId) continue;
        const dx = r.pos.x - rx;
        const dy = r.pos.y - ry;
        const dz = r.pos.z - rz;
        const dSq = dx * dx + dy * dy + dz * dz;
        // Tier 4 (200ms spacing) read as mini-warps even through the
        // interpolation buffer — a skiing bot covers ~8m between records.
        // 150ms is the worst a body ever gets; hits/kills ride reliable
        // events either way.
        const tier = dSq < 22500 ? 1 : dSq < 160000 ? 2 : 3; // 150m / 400m
        // force = hit/knockback window: real positions must reach every
        // observer at full rate while they extrapolate the knockback
        if (r.force || seq % tier === 0) others.push(r.data);
        else this.metrics.recordsTierSkipped++;
      }
      // Always send — even an empty frame. The client's loss telemetry
      // keys on tick-frame ARRIVAL cadence (a silent link reads as 100%
      // loss), and ackSeq rides this frame: a quiet room would starve
      // stateHistory pruning entirely. ~10B × 20Hz is free.
      const frame = encodeTickFrame(
        room.players.getLastSeq(recipientId),
        seq,
        others,
      );
      this.metrics.recordsSent += others.length;
      this.metrics.bytesSent += frame.byteLength;
      // Dropped frames surface as tickSeq gaps client-side — count them
      // here so a consumer that can't drain reads as rising loss, not
      // as an unexplained stutter nobody can attribute.
      if (room.connections.sendBinaryToPlayer(recipientId, frame) === 'backlogged') this.metrics.tickFramesDropped++;
    }
    // Spectators have no viewpoint for interest tiers — they get the
    // full record set every tick.
    if (room.spectators.size > 0) {
      for (const id of room.spectators) {
        // Same ackSeq contract as player frames — a spectator who spawns
        // mid-session must not carry a synthetic seq into history pruning.
        const frame = encodeTickFrame(room.players.getLastSeq(id), seq, records.map(r => r.data));
        this.metrics.bytesSent += frame.byteLength;
        room.connections.sendBinaryToPlayer(id, frame);
      }
    }
  }
}
