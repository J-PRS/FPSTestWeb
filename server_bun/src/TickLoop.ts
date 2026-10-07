import { CONFIG } from './config.ts';
import type { Room } from './Room.ts';
import { computeStateHash, computeReplicaHash, computeCreatureHash, computeDeployHash, computeFlagHash, computePickupHash } from '../../shared/stateHash.ts';
import { logger } from './logger.ts';
import { TickFanout } from './tickRecords.ts';
import { wallNow } from './wallClock.ts';
import { simNow } from './simClock.ts';
import { evictEldest } from './evictEldest.ts';

// Heal/suppression helpers live in tickHelpers.ts so tickRecords doesn't
// import this file — re-exported here because scenario tests import them
// from TickLoop.
export { healPerTick, recordSuppressed, type TickRecord } from './tickHelpers.ts';

/** Sim step per tick — must equal the broadcast interval or game time
 *  drifts off wall-clock whenever FPS_TICK_HZ ≠ 20. */
const TICK_DT = 1 / CONFIG.tickRate;

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
  private metrics = { ticks: 0, recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0, recordsSent: 0, recordsTierSkipped: 0, bytesSent: 0, tickFramesDropped: 0, tickErrors: 0, windowStart: 0 };
  /** Which phase threw when a room tick dies — the catch sites one level
   *  up can't see inside tickRoom otherwise. */
  private errPhase = '?';
  /** Consecutive tick failures per room — a room that throws every tick
   *  is quarantined instead of burning log+CPU forever. */
  private tickErrStreak = new Map<string, number>();
  private tickQuarantined = new Set<string>();
  /** Rooms drained for repeated tick failures — kept for /metrics
   *  (a quarantined room is deleted, so the gate set alone reports
   *  nothing); a name here is history, not a block on the name. */
  private faultedRooms = new Set<string>();
  /** Per-phase EMA ms inside tickRoom — tick lag says the tick ran
   *  late, this says WHAT was slow (sims vs record build vs fanout)
   *  without a profiler attached. */
  private phases = new Map<string, number>();
  private lastPhaseAt = 0;
  private mark(name: string): void {
    const now = wallNow();
    const d = now - this.lastPhaseAt;
    this.lastPhaseAt = now;
    this.phases.set(name, (this.phases.get(name) ?? d) * 0.9 + d * 0.1);
  }
  /** Last completed 10s rollup — surfaced on /metrics, null until a
   *  window closes (needs a connected player to accumulate). */
  private lastBw: { kbpsDownTotal: number; recordsPerSec: number; suppressedPerSec: number; tierSkippedPerSec: number; tickFramesDroppedPerSec: number; tickErrors: number; phaseMs: Record<string, number> } | null = null;
  bandwidthWindow() { return this.lastBw; }
  /** Rooms stopped for repeated tick failures — /metrics surfaces this
   *  so a dead room is visible on the status page, not just in logs. */
  quarantinedRooms() { return [...this.faultedRooms]; }

  /** Fault state is name-keyed, not instance-keyed — when a room leaves
   *  the roster without a drain (room-cap recycle), a remint under the
   *  same name must start clean or it inherits the corpse's streak and
   *  can quarantine on its first tick error. faultedRooms stays: that
   *  set is ops history, not sim gating. */
  forgetRoom(name: string): void {
    this.tickErrStreak.delete(name);
    this.tickQuarantined.delete(name);
  }

  private readonly fanout: TickFanout;


  constructor(
    private readonly rooms: Map<string, Room>,
    private readonly ops: TickOps,
    private readonly onRemove: (room: Room, playerId: string, reason: string) => void,
  ) {
    this.fanout = new TickFanout(this.metrics, onRemove);
  }

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
      const now0 = wallNow();
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
        // A room that faulted but couldn't be drained (dispose threw
        // inside drainQuarantined) stays in the map — skip it rather
        // than retrying a doomed path every tick.
        if (this.tickQuarantined.has(room.name)) continue;
        // Empty named rooms are teardown: the sim timer + entry would leak
        // per room name otherwise. 'default' is immortal.
        if (room.empty && room.name !== 'default') {
          // Outside tickRoomGuarded's containment — a throwing dispose()
          // would otherwise escape into the interval body uncaught and
          // kill the process for every room.
          try {
            room.dispose();
            this.rooms.delete(room.name);
            // Streak entries are keyed by room name — a disposed room that
            // ever threw would hold its count (and any quarantine flag)
            // for the server's life, then re-arm on a same-named room.
            this.tickErrStreak.delete(room.name);
            this.tickQuarantined.delete(room.name);
            logger.info('Room disposed', { room: room.name });
          } catch (e) {
            const n = (this.tickErrStreak.get(room.name) ?? 0) + 1;
            this.tickErrStreak.set(room.name, n);
            this.metrics.tickErrors++;
            logger.error('Room dispose failed', { room: room.name, streak: n, err: e instanceof Error ? e.stack ?? e.message : String(e) });
            if (n >= 10) {
              this.tickQuarantined.add(room.name);
              this.drainQuarantined(room);
            }
          }
          continue;
        }
        // One bad room state must not kill the whole process for every
        // player — a thrown tick is logged, counted, and a room that
        // throws on ~10 consecutive ticks gets quarantined + drained:
        // a frozen world with live players in it is worse than a kick.
        this.tickRoomGuarded(room, now0);
      }
    }, tickMs);
  }

  /** The per-room tick wrapped in containment — the interval body calls
   *  this; scenario tests can too (tickRoomNow only exercises the raw
   *  body, not the streak → quarantine → drain path). */
  tickRoomGuarded(room: Room, now0 = wallNow()): void {
    if (this.tickQuarantined.has(room.name)) return;
    try {
    // errPhase is module state — a pre-tick throw (match clock,
    // hibernation check) would otherwise log whichever phase a PREVIOUS
    // room died at.
    this.errPhase = 'pre';
    room.checkMatchClock(simNow());
    // Hibernation: nobody watching → freeze ball sim + skip the whole
    // room tick. Bots alone don't count as an audience — they exist
    // to serve humans, and a bot-only 'default' would otherwise sim
    // forever. A rejoining human wakes the room instantly.
    const audience = room.players.getHumanCount() > 0 || room.spectators.size > 0;
    room.ballSim.dormant = !audience;
    // Same hibernation for creatures — an unwatched room spawning
    // crawlers forever burns CPU
    // (and silently grows the crawler population it later dumps on
    // a rejoining player).
    room.creatureSim.dormant = !audience;
    if (!audience) return;
    const players = room.players.getAllPlayers();
    if (players.size === 0) return;
    this.errPhase = 'room';
      this.tickRoom(room, players, now0);
      this.tickErrStreak.delete(room.name);
    } catch (e) {
      // A drain failure leaves the poisoned message queued — it would
      // re-throw every tick until quarantine. Drop the backlog: the
      // unprocessed commands were already lost when the drain aborted.
      room.commands.length = 0;
      const n = (this.tickErrStreak.get(room.name) ?? 0) + 1;
      this.tickErrStreak.set(room.name, n);
      this.metrics.tickErrors++;
      logger.error('Room tick failed', { room: room.name, phase: this.errPhase, streak: n, err: e instanceof Error ? e.stack ?? e.message : String(e) });
      if (n >= 10) {
        this.tickQuarantined.add(room.name);
        logger.error('Room quarantined after repeated tick failures', { room: room.name, phase: this.errPhase });
        this.drainQuarantined(room);
      }
    }
  }

  /** A quarantined room stopped simulating — leaving its humans inside
   *  would show them a frozen world forever. Eject everyone (the client's
   *  reconnect flow lands them in a fresh room), then dispose + drop the
   *  entry so the name can host a live instance again. */
  private drainQuarantined(room: Room): void {
    try {
      for (const p of [...room.players.getAllPlayers().values()]) {
        try { room.socketOf(p.id)?.close(1011, 'room faulted'); } catch { /* socket already dying */ }
        if (!p.isBot) this.onRemove(room, p.id, 'quarantine');
      }
      for (const pid of room.spectators) {
        try { room.socketOf(pid)?.close(1011, 'room faulted'); } catch { /* socket already dying */ }
      }
      room.dispose();
      this.rooms.delete(room.name);
      // Streak/quarantine are name-keyed — clear them or the NEXT room
      // instantiated under this name is born frozen.
      this.tickQuarantined.delete(room.name);
      this.tickErrStreak.delete(room.name);
      this.faultedRooms.add(room.name);
      // Bounded — a fault loop recreating doomed rooms under fresh names
      // would otherwise grow the set one name per ~10 ticks forever.
      if (this.faultedRooms.size > 512) evictEldest(this.faultedRooms);
      logger.info('Quarantined room drained + disposed', { room: room.name });
    } catch (e) {
      logger.error('Quarantine drain failed', { room: room.name, err: e instanceof Error ? e.message : String(e) });
    }
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
  tickRoomNow(room: Room, now0 = wallNow()): void {
    this.tickRoom(room, room.players.getAllPlayers(), now0);
  }

  private tickRoom(room: Room, players: Players, now0: number): void {
    // Phase 0: drain the command buffer — all client input lands before
    // any sim runs, in wire-arrival order.
    this.lastPhaseAt = wallNow();
    this.errPhase = 'cmd';
    room.drainCommands();
    this.mark('cmd');

    // Server sims move first — bot/flag writes land in this tick's
    // records. They get MEASURED elapsed, not the nominal step: setInterval
    // fires late under load (+11ms avg measured), and a fixed 50ms would
    // let sim clocks drift ~18% behind wall time — client replays then
    // overshoot every resync (the ball-rubberband storm). Sims catch up
    // in whole cells inside step(); the cap prevents a hiccup spiral.
    const elapsed = room.lastStepAt > 0 ? (now0 - room.lastStepAt) / 1000 : TICK_DT;
    const dt = Math.min(Math.max(elapsed, TICK_DT), 1);
    room.lastStepAt = now0;
    // Per-sim marks name the hot one — 'sims' as a lump hid which of a
    // dozen systems grew when a tick went slow (bots vs moveSim vs
    // projectiles are different fix paths).
    for (const sim of room.sims) { this.errPhase = `sim:${sim.name ?? '?'}`; sim.tick(dt); this.mark(this.errPhase); }
    this.mark('sims');

    // Authority mode: the shadow sim's output is the broadcast truth.
    // Reports only fed it aim/liveness hints — what every other player
    // sees (and the rewind buffer stores) is the simulated position.
    this.errPhase = 'auth';
    if (room.moveAuthority) {
      for (const [playerId, p] of players) {
        if (p.isBot) continue;
        const s = room.moveSim.simState(playerId);
        if (!s) continue;
        p.position = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
        p.velocity = { x: s.vel.x, y: s.vel.y, z: s.vel.z };
      }
    }
    this.mark('auth');

    this.errPhase = 'records';
    const records = this.fanout.buildRecords(room, players, now0);
    this.mark('records');

    room.tickSeq++;
    this.metrics.ticks++;

    // Unconditional — even an all-suppressed tick must ship an empty
    // frame. The client's loss metric reads arrival CADENCE (a silent
    // stream is ~100% loss) and ackSeq rides every frame, so skipping
    // quiet ticks both lies about link health and starves stateHistory
    // pruning.
    this.errPhase = 'fanout';
    this.fanout.fanoutRecords(room, players, records);
    this.mark('fanout');

    this.errPhase = '?';
    this.rollupMetrics(now0, players.size);
  }

  /** One encoded record per player needing an update this tick — idle
   *  reap, server-owned health regen, stale-heartbeat, and dead-reckoning
   *  suppression all live here. Encodes ONCE; fanout only concatenates. */
  /** Metrics rollup every 10s while anyone's connected — answers "what
   *  did the optimization buy" with real numbers instead of estimates. */
  private rollupMetrics(now0: number, playerCount: number): void {
    const m = this.metrics;
    if (m.windowStart === 0) m.windowStart = now0;
    if (now0 - m.windowStart > 10000) {
      const secs = (now0 - m.windowStart) / 1000;
      const phaseMs: Record<string, number> = {};
      for (const [k, v] of this.phases) phaseMs[k] = +v.toFixed(2);
      this.lastBw = {
        kbpsDownTotal: +(m.bytesSent * 8 / 1000 / secs).toFixed(1),
        recordsPerSec: +(m.recordsSent / secs).toFixed(0),
        suppressedPerSec: +(m.recordsSuppressed / secs).toFixed(0),
        tierSkippedPerSec: +(m.recordsTierSkipped / secs).toFixed(0),
        tickFramesDroppedPerSec: +(m.tickFramesDropped / secs).toFixed(0),
        tickErrors: m.tickErrors,
        phaseMs,
      };
      logger.debug('Tick bandwidth', { ...this.lastBw, players: playerCount });
      m.ticks = m.recordsBuilt = m.recordsSuppressed = m.recordsIdleReaped =
        m.recordsSent = m.recordsTierSkipped = m.bytesSent = m.tickFramesDropped = m.tickErrors = 0;
      m.windowStart = now0;
    }
  }

  private startHashBroadcast(): void {
    this.hashTimer = setInterval(() => {
      for (const room of this.rooms.values()) {
        if (this.tickQuarantined.has(room.name)) continue;
        try { this.broadcastStateHash(room); }
        catch (e) {
          this.metrics.tickErrors++;
          logger.error('State hash broadcast failed', { room: room.name, err: e instanceof Error ? e.message : String(e) });
        }
      }
    }, CONFIG.hashBroadcastIntervalMs);
  }

  private broadcastStateHash(room: Room): void {
    const playerCount = room.playerCount();
    if (playerCount === 0) return;

    // tag the hash with the last EMITTED tick — consuming a fresh
    // tickSeq here would ship a seq no frame ever carries, and every
    // client's loss telemetry counts that phantom skip as a dropped
    // frame (~3% bogus loss at the hash cadence).
    const hash = this.computeStateHash(room);
    // Replica-fidelity hash over the ball fleet — identity + mirrored
    // lifecycle fields (§4.7). Omitted where no ball sim runs so rooms
    // without balls don't emit a meaningless constant.
    const roster = room.ballSim.roster();
    const ballHash = roster.length
      ? computeReplicaHash(roster.map((b) => [b.id, b] as [number, { variant: number; enraged: boolean; targetId: string | null }]))
      : undefined;
    // Same fidelity hash for creatures — species/state/uber/targetId are
    // the mirrored lifecycle fields; a stranded or stale replica reads
    // here where nothing else looks (§4.7).
    const creatureRoster = room.creatureSim.roster();
    const creatureHash = creatureRoster.length
      ? computeCreatureHash(creatureRoster.map((c) => [c.id, c] as [number, { species: string; state: string; uber: boolean; targetId: string | null }]))
      : undefined;
    // Deployables too — kind/owner/team are spawn edges; hp/armor are
    // echo-channel (deployHp ticks) and stay out of the hash on purpose.
    const deployRoster = room.deployables.snapshot();
    const deployHash = deployRoster.length
      ? computeDeployHash(deployRoster.map((d) => [d.id, { kind: d.kind, owner: d.owner, team: d.team ?? '' }] as [number, { kind: string; owner: string; team: string }]))
      : undefined;
    // Flags + pickups — the last edge-driven rosters without a desync
    // signal (§4.7).
    const flagHash = room.flags?.flags.size
      ? computeFlagHash(room.flags.flags)
      : undefined;
    const pickupRoster = room.pickups?.snapshot() ?? [];
    const pickupHash = pickupRoster.length
      ? computePickupHash(pickupRoster.map((p) => [p.id, p] as [number, { kind: string }]))
      : undefined;
    const timestamp = wallNow();

    room.broadcast({
      type: 'stateHash',
      hash,
      tick: room.tickSeq,
      playerCount,
      timestamp,
      ballHash,
      creatureHash,
      deployHash,
      flagHash,
      pickupHash,
      // On a creature-hash miss the client diffs these per-id fields so
      // the warn says WHICH lifecycle field diverged (~30B/creature).
      creatureFields: creatureRoster.length
        ? creatureRoster.map((c) => [c.id, c.species, c.state, c.uber, c.targetId] as [number, string, string, boolean, string | null])
        : undefined,
      // Same per-id detail for the deploy lane — a phantom hash entry
      // (a ghost item, a missing base asset) names itself in the warn.
      deployFields: deployRoster.length
        ? deployRoster.map((d) => [d.id, d.kind, d.owner, d.team ?? ''] as [number, string, string, string])
        : undefined,
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
        logger.debug(`${this.lastStatusLine} [x${this.statusRepeatCount + 1}]`);
        this.statusRepeatCount = 0;
      }
      logger.debug(statusLine);
      this.lastStatusLine = statusLine;
    }

    logger.debug('State hash broadcast', { room: room.name, tick: room.tickSeq, hash, playerCount });
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
