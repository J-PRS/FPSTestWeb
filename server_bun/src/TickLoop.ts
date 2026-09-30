import { CONFIG } from './config.ts';
import type { Room } from './Room.ts';
import { encodeTickPlayer, encodeTickFrame } from '../../shared/wire.ts';
import { STATUS, CLIENT_STATUS_MASK } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
import { POWERUP } from '../../shared/pickups.ts';
import { computeStateHash } from '../../shared/stateHash.ts';
import { logger } from './logger.ts';
import type { PlayerState } from './types.ts';

// Medkit: hp restored per broadcast tick while the mending flag is up.
// 12 hp/s at the room's tick rate — a field patch, not a fountain.
const MEND_HP_PER_TICK = 12 / CONFIG.tickRate;
/** Sim step per tick — must equal the broadcast interval or game time
 *  drifts off wall-clock whenever FPS_TICK_HZ ≠ 20. */
const TICK_DT = 1 / CONFIG.tickRate;

/** Server-owned heal channels for one broadcast tick: medkit channel,
 *  regenerator perk, regen powerup — all cap at the perk max (the caller
 *  applies the clamp). Exported for scenario tests; the loop itself
 *  stays identical. */

export function healPerTick(p: Pick<PlayerState, 'isDead' | 'health' | 'maxHealth' | 'status' | 'regenUntil' | 'perk'>, now: number): number {
  if (p.isDead || p.health >= p.maxHealth) return 0;
  let heal = perkMods(p.perk).regen / CONFIG.tickRate;
  if (p.status & STATUS.MEND) heal += MEND_HP_PER_TICK;
  if (now < p.regenUntil) heal += POWERUP.regenHpPerSec / CONFIG.tickRate;
  return heal;
}

interface SuppressablePlayer { position: { x: number; y: number; z: number }; rotation: { yaw: number; pitch: number }; health: number; isDead: boolean; skiing: number; status: number }
interface SuppressableSent { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; status: number; sheep: number; t: number }

/** Update suppression: if the player still sits where a dead-reckoning
 *  client would extrapolate them (linear pos+vel from the last sent
 *  record), the update carries no new information — skip it. Exported for
 *  scenario tests; the loop itself stays identical. */
export function recordSuppressed(p: SuppressablePlayer, lastSent: SuppressableSent, now: number, sheep = 0): boolean {
  const elapsed = (now - lastSent.t) / 1000;
  const ex = lastSent.x + lastSent.vx * elapsed;
  const ey = lastSent.y + lastSent.vy * elapsed;
  const ez = lastSent.z + lastSent.vz * elapsed;
  const dx = p.position.x - ex;
  const dy = p.position.y - ey;
  const dz = p.position.z - ez;
  const predErrSq = dx * dx + dy * dy + dz * dz;
  // Yaw wraps — a raw |a-b| reads a 6.27→0.01 crossing as a huge turn and
  // permanently defeats suppression for spinners. Compare the shortest arc.
  const yawDiff = Math.abs(((p.rotation.yaw - lastSent.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  const pitchDiff = Math.abs(p.rotation.pitch - lastSent.pitch);
  // State fields (health/death/ski/status) must never be eaten by the
  // position check — a flag change forces the record even when the
  // player hasn't moved.
  // lastSent.status is the wire value — REGEN/DD bits OR'd in at send time —
  // so mask it back to client bits before comparing or a buff defeats
  // suppression for its whole duration.
  const stateChanged = p.health !== lastSent.hp || p.isDead !== lastSent.dead || p.skiing !== lastSent.ski || p.status !== (lastSent.status & CLIENT_STATUS_MASK)
    // Sheep isn't a player field — it lives on the bot driver — so the
    // suppression check reads it off the record args (0 for humans).
    || sheep !== lastSent.sheep;
  // Idle players still heartbeat at 4Hz — a >300ms silence would trigger
  // client-side dead reckoning on a stationary player.
  return !stateChanged && predErrSq < 0.09 && yawDiff < 0.02 && pitchDiff < 0.03 && now - lastSent.t < 250;
}

/** One encoded position update waiting for fanout — data is pre-encoded
 *  once so per-recipient sends are buffer concatenation, not re-serialization. */
export interface TickRecord {
  playerId: string;
  data: Uint8Array;
  pos: { x: number; y: number; z: number };
  force: boolean;
}

type Players = ReturnType<Room['players']['getAllPlayers']>;

/** Shared ops counters — GameServer owns the object; the loop writes
 *  tickLag/lastTickAt so /metrics keeps a single read surface. */
export interface TickOps {
  tickLagMsMax: number;
  tickLagMsSum: number;
  tickLagSamples: number;
  lastTickAt: number;
}

/** The broadcast engine: 20Hz room tick (records + interest tiers +
 *  suppression) and the low-rate state-hash/status broadcast. Owns no
 *  room state — rooms live in the directory map GameServer passes in;
 *  teardown (idle reap, grace expiry) is delegated via onRemove. */
export class TickLoop {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private hashTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatusLine: string = '';
  private statusRepeatCount: number = 0;

  // Tick-bandwidth metrics — aggregated per log window so we can see what
  // interest tiers + suppression are actually saving.
  private metrics = { ticks: 0, recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0, recordsSent: 0, recordsTierSkipped: 0, bytesSent: 0, windowStart: 0 };
  /** Last completed 10s rollup — surfaced on /metrics, null until a
   *  window closes (needs a connected player to accumulate). */
  private lastBw: { kbpsDownTotal: number; recordsPerSec: number; suppressedPerSec: number; tierSkippedPerSec: number } | null = null;
  bandwidthWindow() { return this.lastBw; }

  // Reused per-recipient record list — the fanout loop runs every tick and
  // a fresh Uint8Array[] per recipient was the biggest GC churn source.
  private readonly scratchOthers: Uint8Array[] = [];

  private static readonly IDLE_KICK_MS = CONFIG.idleKickMs; // silent >60s → remove

  constructor(
    private readonly rooms: Map<string, Room>,
    private readonly ops: TickOps,
    private readonly onRemove: (room: Room, playerId: string, reason: string) => void,
  ) {}

  start(): void {
    this.startHashBroadcast();
    this.startTickBroadcast();
  }

  stop(): void {
    this.stopHashBroadcast();
    this.stopTickBroadcast();
  }

  private startTickBroadcast(): void {
    const tickMs = 1000 / CONFIG.tickRate;
    this.tickTimer = setInterval(() => {
      const now0 = Date.now();
      // Tick lag: how late this interval fired vs the nominal cadence.
      // Sustained lag = sim clock drifts behind wall time — the skew that
      // pushes client ball replays ahead of authority.
      if (this.ops.lastTickAt > 0) {
        const lag = now0 - this.ops.lastTickAt - tickMs;
        this.ops.tickLagMsSum += lag;
        this.ops.tickLagSamples++;
        if (lag > this.ops.tickLagMsMax) this.ops.tickLagMsMax = lag;
      }
      this.ops.lastTickAt = now0;

      for (const room of this.rooms.values()) {
        // Empty named rooms are teardown: the sim timer + entry would leak
        // per room name otherwise. 'default' is immortal.
        if (room.empty && room.name !== 'default') {
          room.dispose();
          this.rooms.delete(room.name);
          logger.info('Room disposed', { room: room.name });
          continue;
        }
        room.checkMatchClock(now0);
        // Hibernation: nobody watching → freeze ball sim + skip the whole
        // room tick. Bots alone don't count as an audience — they exist
        // to serve humans, and a bot-only 'default' would otherwise sim
        // forever. A rejoining human wakes the room instantly.
        const audience = room.players.getHumanCount() > 0 || room.spectators.size > 0;
        room.ballSim.dormant = !audience;
        // Same hibernation for creatures — the sim's own interval keeps
        // ticking when nobody can see it, unlike the room tick it can't
        // reach. An unwatched room simming spawns forever burns CPU
        // (and silently grows the crawler population it later dumps on
        // a rejoining player).
        room.creatureSim.dormant = !audience;
        if (!audience) continue;
        const players = room.players.getAllPlayers();
        if (players.size === 0) continue;
        this.tickRoom(room, players, now0);
      }
    }, tickMs);
  }

  private stopTickBroadcast(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Test seam: run one room tick synchronously (prod path goes through
   *  startTickBroadcast's interval). Public so scenario tests can drive
   *  ticks deterministically — tick bodies stay identical. */
  tickRoomNow(room: Room, now0 = Date.now()): void {
    this.tickRoom(room, room.players.getAllPlayers(), now0);
  }

  private tickRoom(room: Room, players: Players, now0: number): void {
    // Server sims move first — bot/flag writes land in this tick's records.
    for (const sim of room.sims) sim.tick(TICK_DT);

    // Authority mode: the shadow sim's output is the broadcast truth.
    // Reports only fed it aim/liveness hints — what every other player
    // sees (and the rewind buffer stores) is the simulated position.
    if (room.moveAuthority) {
      for (const [playerId, p] of players) {
        if (p.isBot) continue;
        const s = room.moveSim.simState(playerId);
        if (!s) continue;
        p.position = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
        p.velocity = { x: s.vel.x, y: s.vel.y, z: s.vel.z };
      }
    }

    const records = this.buildRecords(room, players, now0);

    room.tickSeq++;
    this.metrics.ticks++;

    // Unconditional — even an all-suppressed tick must ship an empty
    // frame. The client's loss metric reads arrival CADENCE (a silent
    // stream is ~100% loss) and ackSeq rides every frame, so skipping
    // quiet ticks both lies about link health and starves stateHistory
    // pruning.
    this.fanoutRecords(room, players, records);

    this.rollupMetrics(now0, players.size);
  }

  /** One encoded record per player needing an update this tick — idle
   *  reap, server-owned health regen, stale-heartbeat, and dead-reckoning
   *  suppression all live here. Encodes ONCE; fanout only concatenates. */
  private buildRecords(room: Room, players: Players, now: number): TickRecord[] {
    const records: TickRecord[] = [];
    for (const [playerId, p] of players) {
      if (this.skipRecord(room, playerId, p, now)) continue;
      this.tickServerHeals(room, playerId, p, now);
      const forceSend = now < p.forceSendUntil;
      const lastSent = room.lastSentPositions.get(playerId);
      const sheep = room.bots.sheepOf(playerId);
      if (lastSent && !forceSend && this.isSuppressed(p, lastSent, now, sheep)) {
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
        | (now < p.ddUntil ? STATUS.DD : 0);
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
    if (p.isBot || silenceMs <= TickLoop.IDLE_KICK_MS) return false;
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
    p.health = Math.min(p.maxHealth, p.health + heal);
    // Capping out always echoes — the channel ends here, so the final
    // converged hp would otherwise wait on the next discrete event.
    if (now - p.healthEchoAt >= 500 || p.health >= p.maxHealth) {
      p.healthEchoAt = now;
      room.connections.sendToPlayer(playerId, { type: 'yourHealth', health: p.health });
    }
  }

  /** Suppression: if reported state still matches where the clients' dead
   *  reckoning would put them (linear extrapolation of the last sent
   *  pos+vel), the update carries no new information — skip it.
   *  Constant-velocity skiers extrapolate perfectly; error appears only on
   *  direction change, bounded by the tolerance. */
  private isSuppressed(p: SuppressablePlayer, lastSent: SuppressableSent, now: number, sheep: number): boolean {
    return recordSuppressed(p, lastSent, now, sheep);
  }

  /** Interest management: distance-tiered update rate per recipient.
   *  <150m (engagement range) every tick · <400m half rate · beyond 1/10.
   *  Hits/kills travel on reliable events, so stale far ghosts only lose
   *  smoothness on targets that are visually specks anyway. */
  private fanoutRecords(room: Room, players: Players, records: TickRecord[]): void {
    const seq = room.tickSeq;
    for (const [recipientId, rp] of players) {
      // Grace-period entries have no socket — record filtering for them
      // is wasted work
      if (room.disconnected.has(recipientId)) continue;
      const rx = rp.position.x, ry = rp.position.y, rz = rp.position.z;
      // Scratch array: same array every tick, zero allocation on the hot
      // path — encodeTickFrame consumes it before the next recipient iterates.
      const others = this.scratchOthers;
      others.length = 0;
      for (const r of records) {
        if (r.playerId === recipientId) continue;
        const dx = r.pos.x - rx;
        const dy = r.pos.y - ry;
        const dz = r.pos.z - rz;
        const dSq = dx * dx + dy * dy + dz * dz;
        const tier = dSq < 22500 ? 1 : dSq < 160000 ? 2 : 10; // 150m / 400m
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
      room.connections.sendBinaryToPlayer(recipientId, frame);
    }
    // Spectators have no viewpoint for interest tiers — they get the
    // full record set every tick.
    if (room.spectators.size > 0) {
      const frame = encodeTickFrame(room.tickSeq, room.tickSeq, records.map(r => r.data));
      this.metrics.bytesSent += frame.byteLength * room.spectators.size;
      for (const id of room.spectators) room.connections.sendBinaryToPlayer(id, frame);
    }
  }

  /** Metrics rollup every 10s while anyone's connected — answers "what
   *  did the optimization buy" with real numbers instead of estimates. */
  private rollupMetrics(now0: number, playerCount: number): void {
    const m = this.metrics;
    if (m.windowStart === 0) m.windowStart = now0;
    if (now0 - m.windowStart > 10000) {
      const secs = (now0 - m.windowStart) / 1000;
      this.lastBw = {
        kbpsDownTotal: +(m.bytesSent * 8 / 1000 / secs).toFixed(1),
        recordsPerSec: +(m.recordsSent / secs).toFixed(0),
        suppressedPerSec: +(m.recordsSuppressed / secs).toFixed(0),
        tierSkippedPerSec: +(m.recordsTierSkipped / secs).toFixed(0),
      };
      logger.info('Tick bandwidth', { ...this.lastBw, players: playerCount });
      m.ticks = m.recordsBuilt = m.recordsSuppressed = m.recordsIdleReaped =
        m.recordsSent = m.recordsTierSkipped = m.bytesSent = 0;
      m.windowStart = now0;
    }
  }

  private startHashBroadcast(): void {
    this.hashTimer = setInterval(() => {
      for (const room of this.rooms.values()) {
        const playerCount = room.playerCount();
        if (playerCount === 0) continue;

        room.tickSeq++;
        const hash = this.computeStateHash(room);
        const timestamp = Date.now();

        room.broadcast({
          type: 'stateHash',
          hash,
          tick: room.tickSeq,
          playerCount,
          timestamp,
        });

        // Periodic status summary - suppress duplicates, batch with count
        const players = room.players.getAllPlayers();
        const summary = Array.from(players.entries()).map(([id, p]) =>
          `${id}[${p.kills}/${p.deaths}] ${p.isDead ? 'DEAD' : `HP${p.health}`} @(${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)})`
        ).join(' | ');
        const statusLine = `Status [${room.name} · ${playerCount} players] ${summary}`;

        if (statusLine === this.lastStatusLine) {
          this.statusRepeatCount++;
        } else {
          if (this.statusRepeatCount > 0) {
            logger.info(`${this.lastStatusLine} [x${this.statusRepeatCount + 1}]`);
            this.statusRepeatCount = 0;
          }
          logger.info(statusLine);
          this.lastStatusLine = statusLine;
        }

        logger.debug('State hash broadcast', { room: room.name, tick: room.tickSeq, hash, playerCount });
      }
    }, CONFIG.hashBroadcastIntervalMs);
  }

  private stopHashBroadcast(): void {
    if (this.hashTimer) {
      clearInterval(this.hashTimer);
      this.hashTimer = null;
    }
  }

  private computeStateHash(room: Room): string {
    // shared/stateHash.ts owns the algorithm — the client recomputes the
    // same hash from its view, so both ends must stay on one definition.
    const flat = new Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>();
    for (const [id, p] of room.players.getAllPlayers()) {
      flat.set(id, { x: p.position.x, y: p.position.y, z: p.position.z, health: p.health, isDead: p.isDead });
    }
    return computeStateHash(flat);
  }
}
