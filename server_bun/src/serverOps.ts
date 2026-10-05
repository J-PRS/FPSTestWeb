import { CONFIG } from './config.js';
import type { GameServer } from './GameServer.js';
import { wallNow } from './wallClock.ts';

// Ops/metrics surface — totalPlayers, the server-browser card, the
// /health row and the /metrics snapshot. GameServer is the host; these
// take it flat (same pattern as the client *Host splits).

export function totalPlayers(g: GameServer): number {
  let n = 0;
  for (const room of g.rooms.values()) n += room.playerCount();
  return n;
}
  /** Server-browser card: what a master list / LAN browser displays per
   *  host. Cheap to poll — one row per room, no per-player data. */
export function getServerInfo(g: GameServer) {
    const uptimeS = Math.floor((wallNow() - g.ops.startedAt) / 1000);
    return {
      name: CONFIG.serverName,
      region: CONFIG.serverRegion || undefined,
      tickRate: CONFIG.tickRate,
      maxPlayers: CONFIG.maxPlayers,
      players: totalPlayers(g),
      uptimeS,
      rooms: g.listRooms(),
    };
  }

export function getHealthStatus(g: GameServer): { status: string; players: number; maxPlayers: number; tickRate: number } {
    return {
      status: 'running',
      players: totalPlayers(g),
      maxPlayers: CONFIG.maxPlayers,
      tickRate: CONFIG.tickRate,
    };
  }

  /** Ops snapshot for /metrics — counts since boot plus tick-lag stats,
   *  with per-room occupancy/ball counts for match-level observability. */
export function getMetrics(g: GameServer) {
    const o = g.ops;
    const now = wallNow();
    const uptimeS = Math.floor((now - o.startedAt) / 1000);
    const rooms = [...g.rooms.values()].map(r => {
      // ClientStats uplink rollup — fresh reporters only (30s covers a
      // couple of missed sends); bots never report so they can't dilute
      // the human view. Min fps + max loss are the actionable tails.
      let n = 0, fpsSum = 0, fpsMin = Infinity, lossMax = 0, pingMax = 0;
      for (const p of r.players.getAllPlayers().values()) {
        const s = p.clientStats;
        if (!s || now - s.at > 30_000) continue;
        n++; fpsSum += s.fps; fpsMin = Math.min(fpsMin, s.fps);
        lossMax = Math.max(lossMax, s.loss); pingMax = Math.max(pingMax, s.ping);
      }
      return {
      name: r.name,
      players: r.playerCount(),
      balls: r.ballSim.ballCount,
      clientStats: n ? { n, fpsAvg: Math.round(fpsSum / n), fpsMin, lossMax, pingMax } : undefined,
      scores: r.modeSpec?.teams ? { ...r.scores } : undefined,
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
        rss: +(mem.rss / 1048576).toFixed(1),
        heapUsed: +(mem.heapUsed / 1048576).toFixed(1),
        heapTotal: +(mem.heapTotal / 1048576).toFixed(1),
      },
      // Last 10s tick-fanout window — null until a player has been connected
      // long enough to close one.
      bandwidth: g.tickLoop.bandwidthWindow(),
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
        avg: o.tickLagSamples ? +(o.tickLagMsSum / o.tickLagSamples).toFixed(2) : 0,
        max: o.tickLagMsMax,
      },
    };
  }

