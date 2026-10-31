import { CONFIG } from './config.ts';
import type { Room } from './Room.ts';
import { computeStateHash, replicaHash } from '../../shared/stateHash.ts';
import { WORLD_MODEL, kindFields, type WorldKindDecl } from '../../shared/worldModel.ts';
import { logger } from './logger.ts';
import { TickFanout } from './tickRecords.ts';
import { wallNow } from './wallClock.ts';
import { simNow } from './simClock.ts';
import { evictEldest } from './evictEldest.ts';

// Heal/suppression helpers live in tickHelpers.ts so tickRecords doesn't
// import this file -- re-exported here because scenario tests import them
// from TickLoop.
export { healPerTick, recordSuppressed, type TickRecord } from './tickHelpers.ts';

/** Sim step per tick -- must equal the broadcast interval or game time
 *  drifts off wall-clock whenever FPS_TICK_HZ ≠ 20. */
const TICK_DT = 1 / CONFIG.tickRate;

type Players = ReturnType<Room['players']['getAllPlayers']>;

/** Shared ops counters -- GameServer owns the object; the loop writes
 *  tickLag/lastTickAt so /metrics keeps a single read surface. */
export interface TickOps {
  tickLagMsMax: number;
  tickLagMsSum: number;
  tickLagSamples: number;
  lastTickAt: number;
  ticksDropped?: number;
}

/** The broadcast engine: 20Hz room tick (records + interest tiers +
 *  suppression) and the low-rate state-hash/status broadcast. Owns no
 *  room state -- rooms live in the directory map GameServer passes in;
 *  teardown (idle reap, grace expiry) is delegated via onRemove. */
const emitLane = <T extends { id: number }>(kind: WorldKindDecl, roster: T[]): { hash: string; fields: unknown[][]; } | undefined =>
  roster.length > 0
    ? { hash: replicaHash(kind, roster.map((e): [number, Record<string, unknown>] => [e.id, e] as [number, Record<string, unknown>])),
        fields: kindFields(kind, roster) }
    : undefined;

export class TickLoop {
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private hashTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatusLine = '';
  private statusRepeatCount = 0;

  // Tick-bandwidth metrics -- aggregated per log window so we can see what
  // interest tiers + suppression are actually saving.
  private metrics = { ticks: 0, recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0, recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, recordsCapped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0, tickErrors: 0, windowStart: 0, tickMsSum: 0, tickMsMax: 0, tickSamples: 0 };
  /** Which phase threw when a room tick dies -- the catch sites one level
   *  up can't see inside tickRoom otherwise. */
  private errPhase = '?';
  /** Consecutive tick failures per room -- a room that throws every tick
   *  is quarantined instead of burning log+CPU forever. */
  private tickErrStreak = new Map<string, number>();
  private tickQuarantined = new Set<string>();
  /** Rooms drained for repeated tick failures -- kept for /metrics
   *  (a quarantined room is deleted, so the gate set alone reports
   *  nothing); a name here is history, not a block on the name. */
  private faultedRooms = new Set<string>();
  /** Per-phase EMA ms inside tickRoom -- tick lag says the tick ran
   *  late, this says WHAT was slow (sims vs record build vs fanout)
   *  without a profiler attached. */
  private phases = new Map<string, number>();
  private lastPhaseAt = 0;
  /** Phase marks run every Nth tick -- a per-tick debug EMA was ~1.7% of
   *  profile samples at 640 room-ticks/s. Whole ticks, not every-10th
   *  mark: intra-tick deltas only make sense against THIS tick's t0. */
  private phaseSampling = false;
  private phaseTick = 0;
  private static PHASE_SAMPLE_EVERY = 10;
  private mark(name: string): void {
    if (!this.phaseSampling) {return;}
    const now = wallNow();
    const d = now - this.lastPhaseAt;
    this.lastPhaseAt = now;
    this.phases.set(name, (this.phases.get(name) ?? d) * 0.9 + d * 0.1);
  }
  /** Last completed 10s rollup -- surfaced on /metrics, null until a
   *  window closes (needs a connected player to accumulate). */
  private lastBw: { kbpsDownTotal: number; recordsPerSec: number; suppressedPerSec: number; tierSkippedPerSec: number; cappedPerSec: number; tickFramesDroppedPerSec: number; tickFramesHeldPerSec: number; sendsPerSec: number; sendUsPerCall: number; tickErrors: number; phaseMs: Record<string, number>; tickMs?: { avg: number; max: number }; worstTicks?: { ms: number; room: string; cmd: number; sims: number; auth: number; rec: number; fan: number; at: number }[] } | null = null;
  /** Worst ticks this rollup window -- a bare tickMsMax never says WHICH
   *  phase held the spike, and "code vs GC/deschedule" is the whole
   *  question: a 200ms tick whose spans sum to 2ms is a runtime pause,
   *  a 200ms 'fan' span is ours. Per-tick stamps are ~6 wallNow calls --
   *  cheap vs the mark() EMA's measured cost. */
  private worstTicks: { ms: number; room: string; cmd: number; sims: number; auth: number; rec: number; fan: number; at: number }[] = [];
  bandwidthWindow() { return this.lastBw; }
  /** Rooms stopped for repeated tick failures -- /metrics surfaces this
   *  so a dead room is visible on the status page, not just in logs. */
  quarantinedRooms(): string[] { return [...this.faultedRooms]; }

  /** Fault state is name-keyed, not instance-keyed -- when a room leaves
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
    // Deadline-compensated setTimeout, not setInterval: the interval
    // rearms relative to callback END, so phase error accumulates (and on
    // Windows the 15.6ms timer tick quantized us to ~28/39ms slots -- the
    // jitter lands in every client's arrival EMA → inflated interpDelay).
    // Chasing a fixed wall-clock deadline removes both.
    let next = wallNow() + tickMs;
    const fire = (): void => {
      const now0 = wallNow();
      // Tick lag: how late this fire landed vs the deadline cadence.
      // Sustained lag = sim clock drifts behind wall time -- the skew that
      // pushes client ball replays ahead of authority.
      if (this.ops.lastTickAt > 0) {
        const lag = now0 - this.ops.lastTickAt - tickMs;
        this.ops.tickLagMsSum += lag;
this.ops.tickLagSamples += 1;
        if (lag > this.ops.tickLagMsMax) {this.ops.tickLagMsMax = lag;}
      }
      this.ops.lastTickAt = now0;
      next += tickMs;
      let delay = next - wallNow();
      if (delay < -tickMs) {
        // Overran a whole tick -- chasing the missed deadline would
        // double-fire. Resync forward; the dropped slot is counted by
        // the tickSeq gap the client already sees.
        this.ops.ticksDropped = (this.ops.ticksDropped ?? 0) + Math.floor(-delay / tickMs);
        next = wallNow() + tickMs;
        delay = tickMs;
      }
      this.tickTimer = setTimeout(fire, Math.max(0, delay));

      for (const room of this.rooms.values()) {
        // A room that faulted but couldn't be drained (dispose threw
        // inside drainQuarantined) stays in the map -- skip it rather
        // than retrying a doomed path every tick.
        if (this.tickQuarantined.has(room.name)) {continue;}
        // Empty named rooms are teardown: the sim timer + entry would leak
        // per room name otherwise. 'default' is immortal; spec-standing
        // lobbies (duel-1) hibernate instead of disposing.
        if (room.empty && room.name !== 'default' && !room.standing) {
          // Outside tickRoomGuarded's containment -- a throwing dispose()
          // would otherwise escape into the interval body uncaught and
          // kill the process for every room.
          try {
            room.dispose();
            this.rooms.delete(room.name);
            // Streak entries are keyed by room name -- a disposed room that
            // ever threw would hold its count (and any quarantine flag)
            // for the server's life, then re-arm on a same-named room.
            this.tickErrStreak.delete(room.name);
            this.tickQuarantined.delete(room.name);
            logger.info('Room disposed', { room: room.name });
          } catch (error) {
            const n = (this.tickErrStreak.get(room.name) ?? 0) + 1;
            this.tickErrStreak.set(room.name, n);
this.metrics.tickErrors += 1;
            logger.error('Room dispose failed', { room: room.name, streak: n, err: error instanceof Error ? error.stack ?? error.message : String(error) });
            if (n >= 10) {
              this.tickQuarantined.add(room.name);
              this.drainQuarantined(room);
            }
          }
          continue;
        }
        // One bad room state must not kill the whole process for every
        // player -- a thrown tick is logged, counted, and a room that
        // throws on ~10 consecutive ticks gets quarantined + drained:
        // a frozen world with live players in it is worse than a kick.
        this.tickRoomGuarded(room, now0);
      }
    };
    this.tickTimer = setTimeout(fire, tickMs);
  }

  /** The per-room tick wrapped in containment -- the interval body calls
   *  this; scenario tests can too (tickRoomNow only exercises the raw
   *  body, not the streak → quarantine → drain path). */
  tickRoomGuarded(room: Room, now0 = wallNow()): void {
    if (this.tickQuarantined.has(room.name)) {return;}
    try {
    // errPhase is module state -- a pre-tick throw (match clock,
    // hibernation check) would otherwise log whichever phase a PREVIOUS
    // room died at.
    this.errPhase = 'pre';
    room.checkMatchClock(simNow());
    // Hibernation: nobody watching → freeze ball sim + skip the whole
    // room tick. Bots alone don't count as an audience -- they exist
    // to serve humans, and a bot-only 'default' would otherwise sim
    // forever. A rejoining human wakes the room instantly.
    const audience = room.players.getHumanCount() > 0 || room.spectators.size > 0;
    room.ballSim.dormant = !audience;
    // Same hibernation for creatures -- an unwatched room spawning
    // crawlers forever burns CPU
    // (and silently grows the crawler population it later dumps on
    // a rejoining player).
    room.creatureSim.dormant = !audience;
    if (!audience) {return;}
    const players = room.players.getAllPlayers();
    if (players.size === 0) {return;}
    this.errPhase = 'room';
      this.tickRoom(room, players, now0);
      this.tickErrStreak.delete(room.name);
    } catch (error) {
      // A drain failure leaves the poisoned message queued -- it would
      // re-throw every tick until quarantine. Drop the backlog: the
      // unprocessed commands were already lost when the drain aborted.
      room.commands.length = 0;
      const n = (this.tickErrStreak.get(room.name) ?? 0) + 1;
      this.tickErrStreak.set(room.name, n);
this.metrics.tickErrors += 1;
      logger.error('Room tick failed', { room: room.name, phase: this.errPhase, streak: n, err: error instanceof Error ? error.stack ?? error.message : String(error) });
      if (n >= 10) {
        this.tickQuarantined.add(room.name);
        logger.error('Room quarantined after repeated tick failures', { room: room.name, phase: this.errPhase });
        this.drainQuarantined(room);
      }
    }
  }

  /** A quarantined room stopped simulating -- leaving its humans inside
   *  would show them a frozen world forever. Eject everyone (the client's
   *  reconnect flow lands them in a fresh room), then dispose + drop the
   *  entry so the name can host a live instance again. */
  private drainQuarantined(room: Room): void {
    try {
      for (const p of room.players.getAllPlayers().values()) {
        try { room.socketOf(p.id)?.close(1011, 'room faulted'); } catch { /* socket already dying */ }
        if (!p.isBot) {this.onRemove(room, p.id, 'quarantine');}
      }
      for (const pid of room.spectators) {
        try { room.socketOf(pid)?.close(1011, 'room faulted'); } catch { /* socket already dying */ }
      }
      room.dispose();
      this.rooms.delete(room.name);
      // Streak/quarantine are name-keyed -- clear them or the NEXT room
      // instantiated under this name is born frozen.
      this.tickQuarantined.delete(room.name);
      this.tickErrStreak.delete(room.name);
      this.faultedRooms.add(room.name);
      // Bounded -- a fault loop recreating doomed rooms under fresh names
      // would otherwise grow the set one name per ~10 ticks forever.
      if (this.faultedRooms.size > 512) {evictEldest(this.faultedRooms);}
      logger.info('Quarantined room drained + disposed', { room: room.name });
    } catch (error) {
      logger.error('Quarantine drain failed', { room: room.name, err: error instanceof Error ? error.message : String(error) });
    }
  }

  private stopTickBroadcast(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Test seam: run one room tick synchronously (prod path goes through
   *  startTickBroadcast's interval). Public so scenario tests can drive
   *  ticks deterministically -- tick bodies stay identical. */
  tickRoomNow(room: Room, now0 = wallNow()): void {
    this.tickRoom(room, room.players.getAllPlayers(), now0);
  }

  private tickRoom(room: Room, players: Players, now0: number): void {
    // Phase 0: drain the command buffer -- all client input lands before
    // any sim runs, in wire-arrival order.
    const tickT0 = wallNow();
    this.phaseSampling = (this.phaseTick += 1) % TickLoop.PHASE_SAMPLE_EVERY === 0;
    this.lastPhaseAt = tickT0;
    this.errPhase = 'cmd';
    // Everything this tick generates queues per-conn -- one merged send
    // per socket at flush instead of N (send-call count is the profile's
    // biggest slice).
    room.connections.beginCollect();
    room.drainCommands();
    this.mark('cmd');
    const tCmd = wallNow();

    // Server sims move first -- bot/flag writes land in this tick's
    // records. They get MEASURED elapsed, not the nominal step: setInterval
    // fires late under load (+11ms avg measured), and a fixed 50ms would
    // let sim clocks drift ~18% behind wall time -- client replays then
    // overshoot every resync (the ball-rubberband storm). Sims catch up
    // in whole cells inside step(); the cap prevents a hiccup spiral.
    const elapsed = room.lastStepAt > 0 ? (now0 - room.lastStepAt) / 1000 : TICK_DT;
    const dt = Math.min(Math.max(elapsed, TICK_DT), 1);
    room.lastStepAt = now0;
    // Per-sim marks name the hot one -- 'sims' as a lump hid which of a
    // dozen systems grew when a tick went slow (bots vs moveSim vs
    // projectiles are different fix paths).
    for (const sim of room.sims) { this.errPhase = `sim:${sim.name ?? '?'}`; sim.tick(dt); this.mark(this.errPhase); }
    this.mark('sims');
    const tSims = wallNow();

    // Authority mode: the shadow sim's output is the broadcast truth.
    // Reports only fed it aim/liveness hints -- what every other player
    // sees (and the rewind buffer stores) is the simulated position.
    // The shadow trails each client by its uplink transit (inputs land
    // transit late, so its boundary runs that much stale) -- without the
    // lead, every observer aims at where the player was ~ping ago:
    // ghost targets, unregistered hits, correction snaps on the victim.
    // A velocity-linear lead re-centers the systematic offset; turn
    // error survives but stops being one-sided.
    this.errPhase = 'auth';
    if (room.moveAuthority) {
      for (const [playerId, p] of players) {
        if (p.isBot) {continue;}
        const s = room.moveSim.simState(playerId);
        if (!s) {continue;}
        // Half transit, not full: a linear lead overshoots on turns by
        // the same amount it recovers on straights -- half centers the
        // systematic lag without doubling the turn error.
        const lead = Math.min(room.moveSim.transitOf(playerId) / 2000, 0.3);
        p.position = { x: s.pos.x + s.vel.x * lead, y: s.pos.y + s.vel.y * lead, z: s.pos.z + s.vel.z * lead };
        p.velocity = { x: s.vel.x, y: s.vel.y, z: s.vel.z };
      }
    }
    this.mark('auth');
    const tAuth = wallNow();

    this.errPhase = 'records';
    const records = this.fanout.buildRecords(room, players, now0);
    this.mark('records');
    const tRec = wallNow();

room.tickSeq += 1;
this.metrics.ticks += 1;

    // Unconditional -- even an all-suppressed tick must ship an empty
    // frame. The client's loss metric reads arrival CADENCE (a silent
    // stream is ~100% loss) and ackSeq rides every frame, so skipping
    // quiet ticks both lies about link health and starves stateHistory
    // pruning.
    this.errPhase = 'fanout';
    this.fanout.fanoutRecords(room, players, records);
    room.connections.flushOutboxes();
    this.mark('fanout');

    this.errPhase = '?';
    // Whole-tick wall cost -- the execution-side complement of tickLag
    // (schedule-side). Rising avg = systemic load; spikes = GC/bursts.
    const tEnd = wallNow();
    const tickMs = tEnd - tickT0;
    const w = this.worstTicks;
    if (w.length < 8 || tickMs > w[w.length - 1]!.ms) {
      w.push({ ms: Math.round(tickMs * 10) / 10, room: room.name,
        cmd: Math.round((tCmd - tickT0) * 10) / 10,
        sims: Math.round((tSims - tCmd) * 10) / 10,
        auth: Math.round((tAuth - tSims) * 10) / 10,
        rec: Math.round((tRec - tAuth) * 10) / 10,
        fan: Math.round((tEnd - tRec) * 10) / 10,
        at: room.tickSeq });
      w.sort((a, b): number => b.ms - a.ms);
      if (w.length > 8) {w.length = 8;}
    }
    this.metrics.tickMsSum += tickMs;
    this.metrics.tickSamples += 1;
    if (tickMs > this.metrics.tickMsMax) {this.metrics.tickMsMax = tickMs;}
    this.rollupMetrics(now0, players.size);
  }

  /** One encoded record per player needing an update this tick -- idle
   *  reap, server-owned health regen, stale-heartbeat, and dead-reckoning
   *  suppression all live here. Encodes ONCE; fanout only concatenates. */
  /** Metrics rollup every 10s while anyone's connected -- answers "what
   *  did the optimization buy" with real numbers instead of estimates. */
  private rollupMetrics(now0: number, playerCount: number): void {
    const m = this.metrics;
    if (m.windowStart === 0) {m.windowStart = now0;}
    if (now0 - m.windowStart > 10_000) {
      const secs = (now0 - m.windowStart) / 1000;
      const phaseMs: Record<string, number> = {};
      for (const [k, v] of this.phases) {phaseMs[k] = Number(v.toFixed(2));}
      let sends = 0, sendNs = 0;
      for (const room of this.rooms.values()) {
        sends += room.connections.sendsCount;
        sendNs += room.connections.sendsNs;
        room.connections.sendsCount = 0;
        room.connections.sendsNs = 0;
      }
      this.lastBw = {
        kbpsDownTotal: Number((m.bytesSent * 8 / 1000 / secs).toFixed(1)),
        recordsPerSec: Number((m.recordsSent / secs).toFixed(0)),
        suppressedPerSec: Number((m.recordsSuppressed / secs).toFixed(0)),
        tierSkippedPerSec: Number((m.recordsTierSkipped / secs).toFixed(0)),
        cappedPerSec: Number((m.recordsCapped / secs).toFixed(0)),
        tickFramesDroppedPerSec: Number((m.tickFramesDropped / secs).toFixed(0)),
        tickFramesHeldPerSec: Number((m.tickFramesHeld / secs).toFixed(0)),
        // Actual ws.send count + µs/call inside flushOutboxes -- the
        // cpuprofile's top line was 'send' at ~36%; this makes the
        // per-call cost a measured number, not an estimate.
        sendsPerSec: Number((sends / secs).toFixed(0)),
        sendUsPerCall: sends > 0 ? Number((sendNs / sends / 1000).toFixed(1)) : 0,
        tickErrors: m.tickErrors,
        phaseMs,
        tickMs: m.tickSamples ? { avg: Number((m.tickMsSum / m.tickSamples).toFixed(2)), max: Number(m.tickMsMax.toFixed(2)) } : undefined,
        worstTicks: [...this.worstTicks],
      };
      this.worstTicks = [];
      m.tickMsSum = 0; m.tickMsMax = 0; m.tickSamples = 0;
      logger.debug('Tick bandwidth', Object.assign({}, this.lastBw, {players: playerCount}));
      m.tickErrors = 0; m.recordsIdleReaped = m.tickErrors; m.recordsSuppressed = m.recordsIdleReaped; m.recordsBuilt = m.recordsSuppressed; m.ticks = m.recordsBuilt;
        m.recordsCapped = m.ticks;
        m.tickFramesDropped = m.tickErrors;
        m.tickFramesHeld = m.tickFramesDropped;
        m.bytesSent = m.tickFramesHeld;
        m.recordsTierSkipped = m.bytesSent;
        m.recordsSent = m.recordsTierSkipped;
      m.windowStart = now0;
    }
  }

  private startHashBroadcast(): void {
    this.hashTimer = setInterval((): void => {
      for (const room of this.rooms.values()) {
        if (this.tickQuarantined.has(room.name)) {continue;}
        try { this.broadcastStateHash(room); }
        catch (error) {
this.metrics.tickErrors += 1;
          logger.error('State hash broadcast failed', { room: room.name, err: error instanceof Error ? error.message : String(error) });
        }
      }
    }, CONFIG.hashBroadcastIntervalMs);
  }

  private broadcastStateHash(room: Room): void {
    const playerCount = room.playerCount();
    if (playerCount === 0) {return;}

    // tag the hash with the last EMITTED tick -- consuming a fresh
    // tickSeq here would ship a seq no frame ever carries, and every
    // client's loss telemetry counts that phantom skip as a dropped
    // frame (~3% bogus loss at the hash cadence).
    const hash = this.computeStateHash(room);
    // §4.7 replica lanes -- one emit body per kind instead of five copies:
    // hash the roster + ship per-id fields for the client's diff pass,
    // both generated from the kind's declaration so emit and diff can't
    // drift apart. Omitted where the roster is empty -- a room without
    // that kind doesn't emit a meaningless constant.
    // Hash the committed wire regime, not the live sim derivative --
    // enraged/targetId re-derive inside each integrator and churn on
    // healthy links; only last-segment state is comparable across ends.
    const ballLane = emitLane(WORLD_MODEL.ball!, room.ballSim.contractRoster());
    const creatureLane = emitLane(WORLD_MODEL.creature!, room.creatureSim.roster());
    const deployLane = emitLane(WORLD_MODEL.deploy!, room.deployables.snapshot());
    // Hash only what the wire carries -- 'unspawned' never leaves the
    // server (snapshot filters it), so hashing it desyncs every
    // pre-blood rabbit room forever. Emitting an empty lane (not
    // undefined) keeps a client ghost replica tripping the check.
    const flagHash = room.flags
      ? replicaHash(WORLD_MODEL.flag!, [...room.flags.flags].filter(
          ([, f]): boolean => f.state !== 'unspawned') as Iterable<[string, Record<string, unknown>]>)
      : undefined;
    const pickupLane = emitLane(WORLD_MODEL.pickup!, room.pickups?.snapshot() ?? []);
    const timestamp = wallNow();

    room.broadcast({
      type: 'stateHash',
      hash,
      tick: room.tickSeq,
      playerCount,
      timestamp,
      // Per-id fields the client diffs on a hash miss -- the tuple order
      // is the declaration's field order, so emit and diff can't drift.
      replica: {
        ball: ballLane,
        creature: creatureLane,
        deploy: deployLane,
        flag: flagHash ? { hash: flagHash } : undefined,
        pickup: pickupLane,
      },
    });

    // Periodic status summary - suppress duplicates, batch with count
    const players = room.players.getAllPlayers();
    const summary = Array.from(players.entries()).map(([id, p]): string =>
      `${id}[${p.kills}/${p.deaths}] ${p.isDead ? 'DEAD' : `HP${p.health}`} @(${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)})`
    ).join(' | ');
    const statusLine = `Status [${room.name} · ${playerCount} players] ${summary}`;

    if (statusLine === this.lastStatusLine) {
this.statusRepeatCount += 1;
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
    // shared/stateHash.ts owns the algorithm -- the client recomputes the
    // same hash from its view, so both ends must stay on one definition.
    const flat = new Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>();
    for (const [id, p] of room.players.getAllPlayers()) {
      flat.set(id, { x: p.position.x, y: p.position.y, z: p.position.z, health: p.health, isDead: p.isDead });
    }
    return computeStateHash(flat);
  }
}
