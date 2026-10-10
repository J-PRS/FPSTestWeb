/**
 * TickFanout — the per-tick record family for TickLoop: which players
 * earn a record this tick (skip/reap/suppress), the server-owned health
 * and charge echoes that ride along, and the distance-tiered fanout to
 * each recipient. TickLoop owns the timers/metrics rollup; this owns
 * "what leaves the room this tick".
 */
import type { Room } from './Room.ts';
import { encodeTickPlayerV4, encodeTickFrame, WIRE_TICK_V4, tickEncodeScratch, tickFrameScratch, v4Last, type TickEncodeScratch } from '../../shared/wire.ts';
import { STATUS } from '../../shared/status.ts';
import { lgChargeAt } from '../../shared/combat.ts';
import { logger } from './logger.ts';
import type { PlayerState } from './types.ts';
import { healPerTick, recordSuppressed, type TickRecord } from './tickHelpers.ts';
import { CONFIG } from './config.ts';
import { healPool } from './healPool.ts';
import { simNow } from './simClock.ts';
import { wallNow , wallMs} from './wallClock.ts';

type Players = ReturnType<Room['players']['getAllPlayers']>;
type PooledRecord = TickRecord & { enc: TickEncodeScratch };

/** A retired wireId is reissued only after this much dead time — any
 *  plausible cross-lane reorder window (reliable roster edge vs binary
 *  frames) is sub-second; 60s is paranoia, not measurement. */
const WIRE_ID_QUIET_MS = 60_000;

/** Mint a u16 record id: prefer a retired id that's been quiet long
 *  enough, else extend the counter. The naive `nextWireId++` walked into
 *  the u16 wrap at 65536 total mints — setUint16 mods silently and the
 *  new player's records would resolve to a *live teammate's* binding. */
function mintWireId(room: Room): number {
  const now = wallNow();
  for (const [id, at] of room.wireIdRetired) {
    if (now - at >= WIRE_ID_QUIET_MS) { room.wireIdRetired.delete(id); return id; }
  }
  if (room.nextWireId <= 0xffff) return room.nextWireId++;
  // Space exhausted with nothing quiet enough — take the eldest retired
  // id anyway; strictly better than a silent modulo-wrap.
  const eldest = room.wireIdRetired.keys().next().value;
  if (eldest !== undefined) {
    logger.error('wireId space full — recycling before the quiet window', { room: room.name, id: eldest });
    room.wireIdRetired.delete(eldest);
    return eldest;
  }
  // 65536 simultaneously-bound ids — the room has bigger problems than
  // this collision, but fail loud rather than aliasing silently.
  logger.error('wireId space exhausted — live collision', { room: room.name });
  return (room.nextWireId++ % 0xffff) + 1;
}

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
  // Record pool: build→fanout is synchronous within one tick, so the
  // array, its wrappers, and their encode buffers all recycle — fresh
  // allocations per room per tick were the last steady-state allocs in
  // the fanout path.
  private readonly scratchRecords: PooledRecord[] = [];
  /** One arena for EVERY recipient's frame this tick — send() consumes
   *  the bytes synchronously (uWS cork copy / QUIC datagram copy), so a
   *  fresh ArrayBuffer per player per tick was pure steady-state churn.
   *  The returned view is only valid until the next encode call. */
  private readonly frameArena = tickFrameScratch();

  private static readonly IDLE_KICK_MS = CONFIG.idleKickMs; // silent >60s → remove
  /** v4 masks delta against last-encoded state — a masked field a lost
   *  frame carried stays stale until it changes again or this forces a
   *  full record (15 ticks = 750ms worst-case drift on a torn link). */
  private static readonly FULL_RECORD_EVERY = 15;

  constructor(
    private readonly metrics: FanoutMetrics,
    private readonly onRemove: (room: Room, playerId: string, reason: string) => void,
  ) {}

  buildRecords(room: Room, players: Players, now: number): TickRecord[] {
    const records = this.scratchRecords;
    // Two clocks, two domains: `now` is wallNow (socket silence,
    // suppression windows, echo stamps); simT gates the sim-owned
    // fields (regen/dd/forceSendUntil, chargeT) which are all written
    // with simNow — mixing them desyncs the moment simNow ≠ wall.
    const simT = simNow();
    let recN = 0;
    // Lazily minted only when a new wireId binds — a fresh {} per tick
    // was steady-state garbage for a delta that almost never fires.
    let roster: Record<number, string> | null = null;
    let rosterDirty = false;
    for (const [playerId, p] of players) {
      if (this.skipRecord(room, playerId, p, now)) continue;
      this.tickServerHeals(room, playerId, p, now, simT);
      this.tickChargeEcho(room, playerId, p, now, simT);
      const forceSend = simT < p.forceSendUntil;
      const lastSent = room.lastSentPositions.get(playerId);
      const sheep = room.bots.sheepOf(playerId);
      // Buff bits are server-owned (stripped from client claims at
      // inputMove) so they must be OR-ed on here, not read off p.status.
      // Computed before suppression so a transition breaks the window.
      const wireStatus = p.status
        | (simT < p.regenUntil ? STATUS.REGEN : 0)
        | (simT < p.ddUntil ? STATUS.DD : 0)
        | (lgChargeAt(p.charge, p.chargeT, simT / 1000) > 0 ? STATUS.CHARGED : 0);
      if (lastSent && !forceSend && recordSuppressed(p, lastSent, now, sheep, wireStatus)) {
        this.metrics.recordsSuppressed++;
        continue; // Skip — within extrapolation tolerance
      }
      // Mutate the snapshot in place — a fresh object per record per tick
      // was the last steady-state alloc in this loop.
      let snap = lastSent;
      if (!snap) {
        snap = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, hp: 0, dead: false, ski: 0, jet: 0, status: 0, sheep: 0, t: 0 };
        room.lastSentPositions.set(playerId, snap);
      }
      snap.x = p.position.x; snap.y = p.position.y; snap.z = p.position.z;
      snap.vx = p.velocity.x; snap.vy = p.velocity.y; snap.vz = p.velocity.z;
      snap.yaw = p.rotation.yaw; snap.pitch = p.rotation.pitch;
      snap.hp = p.health; snap.dead = p.isDead; snap.ski = p.skiing; snap.jet = p.jetting;
      snap.status = wireStatus;
      snap.sheep = sheep;
      snap.t = now;

      let wireId = room.wireIds.get(playerId);
      let freshWireId = false;
      if (wireId === undefined) {
        wireId = mintWireId(room);
        room.wireIds.set(playerId, wireId);
        (roster ??= {})[wireId] = playerId;
        rosterDirty = true;
        freshWireId = true;
      }
      let rec = records[recN];
      if (!rec) {
        rec = { playerId: '', data: new Uint8Array(0), pos: { x: 0, y: 0, z: 0 }, force: false, enc: tickEncodeScratch() };
        records.push(rec);
      }
      rec.playerId = playerId;
      rec.pos = p.position;
      // The delta basis is per-wireId and shared across recipients, but
      // fanout skips records per-recipient by distance tier — a field the
      // far client never received stays stale in its decode pool FOREVER
      // (masked-out groups emit the retained slot value). A skipped full
      // would leave that drift unbounded, so forced fulls must bypass
      // tier skipping like hit-window forced sends.
      const fullRecord = freshWireId || (room.tickSeq + wireId) % TickFanout.FULL_RECORD_EVERY === 0;
      rec.force = forceSend || fullRecord;
      // Delta basis follows the wireId, never the slot — a slot-carried
      // `last` encodes this player's mask against whoever held the slot
      // last tick after every roster shuffle.
      let last = room.v4Last.get(wireId);
      if (!last || freshWireId) {
        last = v4Last();
        room.v4Last.set(wireId, last);
      }
      // Delta-masked v4 record: field groups that changed since the
      // K-deep basis ride the wire — a field changed once is resent
      // V4_BASIS_DEPTH times, healing short datagram bursts; a periodic
      // full record bounds whatever longer loss leaves behind.
      rec.data = encodeTickPlayerV4(wireId, {
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
          jet: p.jetting,
          status: snap.status,
          sheep,
          // Stagger fulls by wireId — keying on tickSeq alone synced every
          // record into one egress spike per window; spreading them keeps
          // the same 750ms drift bound with a flat send curve. A fresh
          // mint always fulls: a quiet-window-reissued wireId's `last`
          // could still hold the retired owner's basis, and a masked
          // record would hand receivers the departed owner's hp/flags.
        }, rec.enc, last, fullRecord);
      recN++;
      this.metrics.recordsBuilt++;
    }
    records.length = recN;
    if (rosterDirty) room.connections.broadcast({ type: 'wireIds', add: roster! });
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
    if (room.sessions?.state(playerId) === 'grace') return true;
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
  private tickServerHeals(room: Room, playerId: string, p: PlayerState, now: number, simT: number): void {
    const heal = healPerTick(p, simT); // regenUntil is sim domain
    if (heal <= 0) return;
    healPool(p, heal);
    // Capping out always echoes — the channel ends here, so the final
    // converged hp would otherwise wait on the next discrete event.
    if (now - p.healthEchoAt >= 500 || p.health >= p.maxHealth) {
      p.healthEchoAt = wallMs(now);
      room.connections.sendToPlayer(playerId, { type: 'yourHealth', health: p.health });
    }
  }

  /** The carrier is the one client that can't see the CHARGED status bit
   *  (own records are excluded from fanout) — echo their decayed bank at
   *  0.5Hz so a walking bomb can hear itself crackle. A final 0 lands the
   *  moment the bank drains so the warning doesn't linger. */
  private tickChargeEcho(room: Room, playerId: string, p: PlayerState, now: number, simT: number): void {
    const acc = lgChargeAt(p.charge, p.chargeT, simT / 1000); // chargeT is sim domain
    const live = acc > 0.5;
    if (!live && p.chargeEchoed <= 0) return;
    if (live && now - p.chargeEchoAt < 500) return;
    p.chargeEchoAt = wallMs(now);
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
      if (room.sessions?.state(recipientId) === 'grace') continue;
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
        // Egress is quadratic in roster — the far-field past 600m is a
        // speck on screen, so it earns a record only every 8th tick while
        // the 400-600m band keeps the 150ms worst-case cadence.
        const tier = dSq < 22500 ? 1 : dSq < 160000 ? 2 : dSq < 360000 ? 3 : 8; // 150m / 400m / 600m
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
        // Tick-set confirm: highest inputMove seq the shadow consumed —
        // the client prunes its input journal and sees a starving stream.
        room.moveSim.inputSeqOf(recipientId),
        others,
        WIRE_TICK_V4,
        this.frameArena,
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
      // Shared scratch like the player path — a fresh map() per spectator
      // per tick was the only allocation left in fanout.
      const all = this.scratchOthers;
      all.length = 0;
      for (const r of records) all.push(r.data);
      for (const id of room.spectators) {
        // Same ackSeq contract as player frames — a spectator who spawns
        // mid-session must not carry a synthetic seq into history pruning.
        const frame = encodeTickFrame(room.players.getLastSeq(id), seq, room.moveSim.inputSeqOf(id), all, WIRE_TICK_V4, this.frameArena);
        this.metrics.bytesSent += frame.byteLength;
        room.connections.sendBinaryToPlayer(id, frame);
      }
    }
  }
}
