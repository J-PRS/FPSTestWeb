import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import { readdirSync, readFileSync } from 'node:fs';
import { CONFIG } from './config.js';
import type { GameServer } from './GameServer.js';
import { wallNow } from './wallClock.ts';
import { SERVER_VERSION, SERVER_BUILD } from './version.ts';

// Ops/metrics surface — totalPlayers, the server-browser card, the
// /health row and the /metrics snapshot. GameServer is the host; these
// take it flat (same pattern as the client *Host splits).

// monitorEventLoopDelay — enabled lazily on first scrape (perf_hooks
// needs a live loop on Bun). Exported in ms.
let _eld: IntervalHistogram | null = null;
function eventLoopHist(): IntervalHistogram {
  if (!_eld) {
    _eld = monitorEventLoopDelay({ resolution: 20 });
    _eld.enable();
  }
  return _eld;
}

export function totalPlayers(g: GameServer): number {
  let n = 0;
  for (const room of g.rooms.values()) {n += room.playerCount();}
  return n;
}
  /** Server-browser card: what a master list / LAN browser displays per
   *  host. Cheap to poll — one row per room, no per-player data. */
export function getServerInfo(g: GameServer) {
    const uptimeS = Math.floor((wallNow() - g.ops.startedAt) / 1000);
    return {
      name: CONFIG.serverName,
      version: SERVER_VERSION,
      region: CONFIG.serverRegion || undefined,
      tickRate: CONFIG.tickRate,
      maxPlayers: CONFIG.maxPlayers,
      players: totalPlayers(g),
      uptimeS,
      rooms: g.listRooms(),
    };
  }

export function getHealthStatus(g: GameServer) {
    // 'degraded' when anything's already on fire: a quarantined room
    // stopped simulating, or the tick loop is running meaningfully late.
    // A monitor polling /health sees the failure instead of 'running'.
    const quarantined = g.tickLoop.quarantinedRooms();
    // Bun's setInterval fires ~11ms late at baseline — degraded means the
    // loop is losing a real slice of the 50ms budget, not normal jitter.
    const lagBad = g.ops.tickLagSamples > 100 && g.ops.tickLagMsSum / g.ops.tickLagSamples > 20;
    const degraded = quarantined.length > 0 || lagBad;
    return Object.assign({}, {status: g.draining ? 'draining' : (degraded ? 'degraded' : 'running'),version: SERVER_VERSION,build: SERVER_BUILD,players: totalPlayers(g),maxPlayers: CONFIG.maxPlayers,tickRate: CONFIG.tickRate,boot: process.env.FPS_BOOT ?? null}, (quarantined.length > 0 ? { quarantined } : {}), (lagBad ? { tickLagMsAvg: Number((g.ops.tickLagMsSum / g.ops.tickLagSamples).toFixed(1)) } : {}));
  }

  /** Ops snapshot for /metrics — counts since boot plus tick-lag stats,
   *  with per-room occupancy/ball counts for match-level observability. */
export function getMetrics(g: GameServer) {
    const o = g.ops;
    const now = wallNow();
    // Event-loop stall histogram — catches what tickLag can't: ANY long
    // task on the loop (GC, a fat message handler, sync fs). Reset per
    // scrape so each window is fresh; lazy-init since perf_hooks needs
    // a live loop. Values arrive in ns, exported in ms.
    const eld = eventLoopHist();
    const eldStats = {
      p50: Number((eld.percentile(50) / 1e6).toFixed(2)),
      p99: Number((eld.percentile(99) / 1e6).toFixed(2)),
      max: Number((eld.max / 1e6).toFixed(2)),
    };
    eld.reset();
    const uptimeS = Math.floor((now - o.startedAt) / 1000);
    const rooms = [...g.rooms.values()].map(r => {
      // ClientStats uplink rollup — fresh reporters only (30s covers a
      // couple of missed sends); bots never report so they can't dilute
      // the human view. Min fps + max loss are the actionable tails.
      let n = 0, fpsSum = 0, fpsMin = Infinity, lossMax = 0, pingMax = 0;
      for (const p of r.players.getAllPlayers().values()) {
        const s = p.clientStats;
        if (!s || now - s.at > 30_000) {continue;}
n += 1; fpsSum += s.fps; fpsMin = Math.min(fpsMin, s.fps);
        lossMax = Math.max(lossMax, s.loss); pingMax = Math.max(pingMax, s.ping);
      }
      return {
      name: r.name,
      players: r.playerCount(),
      balls: r.ballSim.ballCount,
      clientStats: n ? { n, fpsAvg: Math.round(fpsSum / n), fpsMin, lossMax, pingMax } : undefined,
      scores: r.modeSpec?.teams ? Object.assign({}, r.scores) : undefined,
      // Bot CPU per stage as ms/sec over the last 10s window — a room
      // melting on think/drive shows it here instead of needing a soak.
      botMs: r.bots ? {
        flagGoal: Number(r.bots.stageMs[0]!.toFixed(1)), build: Number(r.bots.stageMs[1]!.toFixed(1)),
        think: Number(r.bots.stageMs[2]!.toFixed(1)), fire: Number(r.bots.stageMs[3]!.toFixed(1)),
        drive: Number(r.bots.stageMs[4]!.toFixed(1)),
      } : undefined,
      botIdle: r.bots?.parkedCount(),
      botParked: r.bots?.parkedDebug(),
      pickups: r.pickups?.snapshot().length ?? 0,
      gracePending: r.sessions?.graceInRoom(r.name) ?? 0,
      ballSimNow: r.ballSim.simNow,
      // Since-boot judge/claim counters — the room's 15s rollup clears
      // per flush, so scrapes need the cumulative mirror.
      health: Object.fromEntries(r.healthTotal),
      };
    });
    const mem = process.memoryUsage();
    return {
      uptimeS,
      players: totalPlayers(g),
      memMB: {
        rss: Number((mem.rss / 1_048_576).toFixed(1)),
        heapUsed: Number((mem.heapUsed / 1_048_576).toFixed(1)),
        heapTotal: Number((mem.heapTotal / 1_048_576).toFixed(1)),
      },
      // Last 10s tick-fanout window — null until a player has been connected
      // long enough to close one.
      bandwidth: g.tickLoop.bandwidthWindow(),
      quarantined: g.tickLoop.quarantinedRooms(),
      rooms,
      joins: o.joins,
      leaves: o.leaves,
      msgsIn: o.msgsIn,
      msgsRejected: o.msgsRejected,
      // Session lifecycle rollup — live census + per-edge totals +
      // anomaly counters (illegal edges, rebegin-over-live, reclaim on
      // non-live). Anomalies > 0 means lifecycle code disagreed with the
      // state machine — page on it.
      sessions: g.registry.metrics(),
      tiers: { ws: o.tierWs, wt: o.tierWt, rtc: o.tierRtc, other: o.tierOther },
      tickLagMs: {
        avg: o.tickLagSamples ? Number((o.tickLagMsSum / o.tickLagSamples).toFixed(2)) : 0,
        max: o.tickLagMsMax,
      },
      // Deadline overruns the compensated timer skipped — nonzero means
      // the loop stalled hard enough to lose whole ticks (GC pause,
      // syscall storm) rather than merely running late.
      ticksDropped: o.ticksDropped ?? 0,
      eventLoopDelayMs: eldStats,
      // Heap census — heapUsed flat while rss ratchets = allocator cache
      // retention (Bun's libpas holds freed backing stores), not a leak.
      memory: ((): Record<string, number> => {
        const m = process.memoryUsage();
        return { rssMb: Math.round(m.rss / 1_048_576), heapUsedMb: Math.round(m.heapUsed / 1_048_576), heapTotalMb: Math.round(m.heapTotal / 1_048_576) };
      })(),
      // Per-thread CPU (Linux /proc, undefined elsewhere) — splits "JS
      // loop busy" from "native helpers busy" (GC markers/JIT/io) which
      // the cpuprofile can't see. Consumers diff successive scrapes.
      threadCpu: threadCpu(),
    };
  }

/** Linux procfs per-thread cumulative CPU ms (self/task entries' stat).
 *  Returns undefined on platforms without procfs (Windows/macOS). */
function threadCpu(): { tid: number; comm: string; cpuMs: number }[] | undefined {
  try {
    const dir = `/proc/self/task`;
    const out: { tid: number; comm: string; cpuMs: number }[] = [];
    for (const tid of readdirSync(dir)) {
      try {
        const stat = readFileSync(`${dir}/${tid}/stat`, 'utf8');
        // comm is "(name)" possibly containing spaces — split after it.
        const end = stat.lastIndexOf(')');
        const comm = stat.slice(stat.indexOf('(') + 1, end);
        const f = stat.slice(end + 2).split(' ');
        // fields after comm: state(3) → utime is field 14 → index 11
        const utime = Number(f[11] ?? 0), stime = Number(f[12] ?? 0);
        out.push({ tid: Number(tid), comm, cpuMs: Math.round((utime + stime) * 10) }); // 100Hz jiffies
      } catch { /* thread exited mid-read */ }
    }
    return out.sort((a, b): number => b.cpuMs - a.cpuMs).slice(0, 12);
  } catch { return undefined; }
}

