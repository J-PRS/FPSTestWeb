// Client-side desync debugging: periodic state-hash comparison against the
// server, full snapshot diffs on mismatch, and window-scope debug functions
// (takeClientSnapshot / requestServerSnapshot / compareState / exportClientSnapshots).

import Logger, { ChildLogger } from './Logger.js';
import { StateSnapshot, type EntityState, type GameStateSnapshot } from './StateSnapshot.js';
import type { SnapshotPlayer } from '../../../shared/protocol.js';
import type { Player } from '../entities/Player.js';
import type { RemotePlayer } from '../entities/RemotePlayer.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { Projectile } from '../projectiles/Projectile.js';

export interface StateDebugContext {
  networkManager: NetworkManager;
  getPlayer(): Player;
  remotePlayers: Map<string, RemotePlayer>;
  projectiles: Projectile[];
  getLastSentPos(): { x: number; y: number; z: number };
  /** Match state — mode/team/scores/playback, for the diagnostics dump. */
  world?: { mode?: string; localTeam?: string; teamScores?: { alpha: number; bravo: number } | null; ffaScores?: Map<string, number>; matchEndsAt?: number | null; playbackMode?: boolean };
  /** Offline bot referee — bot roster/teams for the diagnostics dump. */
  teamBots?: () => { bots: { playerId: string; team: string; isDead: boolean; position: { x: number; y: number; z: number }; botHp?: number }[]; teamOf: Map<string, string>; over: string | null; scores: { alpha: number; bravo: number }; ffaScores: Map<string, number> } | null;
  logger: ChildLogger;
}

const SNAPSHOT_COOLDOWN_MS = 5000; // Don't request snapshots more often than every 5s
const POSITION_TOLERANCE = 50.0;   // Warn if position delta exceeds this (higher for async snapshot comparison)

let pendingServerSnapshot: ((players: SnapshotPlayer[], timestamp: number) => void) | null = null;

declare global {
  interface Window {
    takeClientSnapshot?: () => GameStateSnapshot;
    requestServerSnapshot?: () => void;
    exportClientSnapshots?: () => void;
    compareState?: () => void;
  }
}

// Build the player map the way the server hashes it: local player uses
// lastSentPos (the server only knows what we've sent), remotes use raw
// NetworkManager data so unrendered players still count.
function buildHashablePlayerMap(ctx: StateDebugContext): Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }> {
  const allPlayers = new Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>();
  const lastSentPos = ctx.getLastSentPos();
  const player = ctx.getPlayer();

  allPlayers.set(ctx.networkManager.getLocalPlayerId(), {
    x: lastSentPos.x,
    y: lastSentPos.y,
    z: lastSentPos.z,
    health: player.health,
    isDead: player.isDead,
  });

  for (const [id, playerData] of ctx.networkManager.getPlayers()) {
    if (id === ctx.networkManager.getLocalPlayerId()) continue; // Skip local player
    const rp = ctx.remotePlayers.get(id);
    const storedPos = playerData?.position;
    allPlayers.set(id, {
      x: storedPos?.x ?? rp?.position.x ?? 0,
      y: storedPos?.y ?? rp?.position.y ?? 0,
      z: storedPos?.z ?? rp?.position.z ?? 0,
      health: playerData?.health ?? 100,
      isDead: playerData?.isDead ?? rp?.isDead ?? false,
    });
  }
  return allPlayers;
}

function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// Diff client-side player state against a server snapshot; returns significant diffs.
function diffServerSnapshot(
  serverPlayers: SnapshotPlayer[],
  clientPlayers: Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>,
): string[] {
  const serverMap = new Map<string, SnapshotPlayer>();
  for (const p of serverPlayers) {
    serverMap.set(p.id, p);
  }

  const diffs: string[] = [];
  const allIds = new Set([...serverMap.keys(), ...clientPlayers.keys()]);

  for (const id of allIds) {
    const cp = clientPlayers.get(id);
    const sp = serverMap.get(id);

    if (!cp || !sp) {
      if (cp !== sp) diffs.push(`Player ${id} on ${cp ? 'client but not server' : 'server but not client'}`);
      continue;
    }

    diffs.push(...diffPlayerFields(id, cp, sp));
  }
  return diffs;
}

function diffPlayerFields(
  id: string,
  cp: { x: number; y: number; z: number; health: number; isDead: boolean },
  sp: { position: { x: number; y: number; z: number }; health: number; isDead: boolean },
): string[] {
  const diffs: string[] = [];
  const dx = Math.abs(cp.x - sp.position.x);
  const dy = Math.abs(cp.y - sp.position.y);
  const dz = Math.abs(cp.z - sp.position.z);
  if (Math.max(dx, dy, dz) > POSITION_TOLERANCE) {
    diffs.push(`Player ${id} position delta=(${dx.toFixed(1)},${dy.toFixed(1)},${dz.toFixed(1)})`);
  }
  if (Math.abs(cp.health - sp.health) > 0) {
    diffs.push(`Player ${id} health: client=${cp.health} server=${sp.health}`);
  }
  if (cp.isDead !== sp.isDead) {
    diffs.push(`Player ${id} isDead: client=${cp.isDead} server=${sp.isDead}`);
  }
  return diffs;
}

function logDiffList(logger: ChildLogger, label: string, noneMessage: string, diffs: string[]): void {
  if (diffs.length === 0) {
    logger.info(noneMessage);
    return;
  }
  logger.warn(`${label} (${diffs.length}):`);
  for (const diff of diffs) {
    logger.warn(`  ${diff}`);
  }
}

// Build a server StateSnapshot from raw player data, compare with the client
// snapshot, and log the full report (hashes, diffs, per-player detail table).
function reportStateComparison(
  logger: ChildLogger,
  clientSnapshot: ReturnType<typeof StateSnapshot.create>,
  serverPlayers: SnapshotPlayer[],
) {
  const serverPlayerMap = new Map<string, Omit<EntityState, 'id'>>();
  for (const p of serverPlayers) {
    serverPlayerMap.set(p.id, {
      position: p.position,
      velocity: p.velocity,
      health: p.health,
      isDead: p.isDead,
      rotation: p.rotation,
    });
  }

  const serverSnapshot = StateSnapshot.create(serverPlayerMap, [], 'server');
  StateSnapshot.save(serverSnapshot);

  const result = StateSnapshot.compare(clientSnapshot, serverSnapshot);

  logger.info('=== STATE COMPARISON ===');
  logger.info(`Hash match: ${result.hashMatch}`);
  logger.info(`Client hash: ${clientSnapshot.hash}`);
  logger.info(`Server hash: ${serverSnapshot.hash}`);

  logDiffList(logger, 'Player differences', 'No player differences found', result.playerDifferences);
  logDiffList(logger, 'Projectile differences', 'No projectile differences found', result.projectileDifferences);

  // Log per-player detail table
  logger.info('=== PLAYER DETAIL ===');
  const allIds = new Set([...serverPlayerMap.keys(), ...clientSnapshot.players.keys()]);
  for (const id of allIds) {
    const cp = clientSnapshot.players.get(id);
    const sp = serverPlayerMap.get(id);
    if (!cp || !sp) {
      logger.info(`  ${id}: ${cp ? 'client only' : 'server only'}`);
      continue;
    }
    const dx = (cp.position.x - sp.position.x).toFixed(2);
    const dy = (cp.position.y - sp.position.y).toFixed(2);
    const dz = (cp.position.z - sp.position.z).toFixed(2);
    const healthMatch = cp.health === sp.health ? 'OK' : `client=${cp.health} server=${sp.health}`;
    const deadMatch = cp.isDead === sp.isDead ? 'OK' : `client=${cp.isDead} server=${sp.isDead}`;
    const posMatch = (dx === '0.00' && dy === '0.00' && dz === '0.00') ? 'OK' : `delta=(${dx},${dy},${dz})`;
    logger.info(`  ${id}: pos=${posMatch} health=${healthMatch} dead=${deadMatch}`);
  }

  return result;
}

// Wire the onSnapshot/onStateHash handlers and expose window debug functions.
// Call once after networkManager exists (post-init).
export function wireStateDebug(ctx: StateDebugContext): void {
  const { networkManager, logger } = ctx;

  networkManager.onSnapshot = (players: SnapshotPlayer[], timestamp: number) => {
    if (pendingServerSnapshot) {
      pendingServerSnapshot(players, timestamp);
      pendingServerSnapshot = null;
    }
  };

  // Auto state hash comparison
  let hashCheckCount = 0;
  let hashMismatchCount = 0;
  let lastSnapshotRequest = 0;

  networkManager.onStateHash = (serverHash: string, tick: number, playerCount: number, _timestamp: number) => {
    hashCheckCount++;

    const allPlayers = buildHashablePlayerMap(ctx);

    // Compute hash using same djb2 algorithm as server
    const sortedIds = Array.from(allPlayers.keys()).sort();
    const hashInput = sortedIds.map(id => {
      const p = allPlayers.get(id)!;
      return `${id}:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}:${p.health}:${p.isDead ? 1 : 0}`;
    }).join('|');

    const localHashStr = djb2Hex(hashInput);

    if (localHashStr === serverHash) {
      logger.debug(`[StateHash] OK tick=${tick} hash=${serverHash} players=${playerCount}`);
      return;
    }

    hashMismatchCount++;
    logger.debug(`[StateHash] MISMATCH tick=${tick} server=${serverHash} client=${localHashStr} input=${hashInput}`);
    const now = Date.now();

    // Only do detailed snapshot comparison if enough time has passed
    if (now - lastSnapshotRequest < SNAPSHOT_COOLDOWN_MS) {
      logger.debug(`[StateHash] MISMATCH tick=${tick} (cooldown, skipping detailed check)`);
      return;
    }
    lastSnapshotRequest = now;

    // Request full snapshot from server for detailed comparison
    const clientPlayers = new Map(allPlayers);
    networkManager.sendSnapshotRequest();

    pendingServerSnapshot = (serverPlayers: SnapshotPlayer[], _ts: number) => {
      const significantDiffs = diffServerSnapshot(serverPlayers, clientPlayers);

      if (significantDiffs.length > 0) {
        logger.warn(`[StateHash] DESYNC DETECTED tick=${tick} hash=${serverHash} vs ${localHashStr} | ${significantDiffs.join('; ')}`, {
          checks: hashCheckCount,
          mismatches: hashMismatchCount,
          matchRate: `${((1 - hashMismatchCount / hashCheckCount) * 100).toFixed(1)}%`,
        });
      } else {
        logger.info(`[StateHash] Hash mismatch tick=${tick} but positions within tolerance (network lag)`);
      }
    };
  };

  // Alt+Q/export header — live game state for bug reports. Keyed toward
  // "why didn't X happen" questions: death/respawn state, connection health,
  // what the server thinks vs what we have.
  Logger.setDiagnostics(() => {
    const nm = ctx.networkManager;
    const p = ctx.getPlayer();
    const w = ctx.world;
    const fmt = (v: { x: number; y: number; z: number }) =>
      `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;
    const wire = nm.getPlayers();
    const lines: string[] = [
      `localId: ${nm.getLocalPlayerId()}`,
      `connected: ${nm.isConnected()} tier: ${nm.getTransportTier() ?? '-'} ping: ${nm.getPing()}ms loss: ${nm.getPacketLoss()}% jitter: ${nm.getJitter()}ms`,
      `local: dead=${p.isDead} hp=${p.health} pos=${fmt(p.pos)} vel=${fmt(p.vel)} yaw=${p.yaw.toFixed(2)} pitch=${p.pitch.toFixed(2)} onGround=${p.onGround}`,
      `lastSentPos: ${fmt(ctx.getLastSentPos())}`,
    ];
    if (w) {
      const clock = w.matchEndsAt ? ` endsIn=${Math.max(0, Math.ceil((w.matchEndsAt - Date.now()) / 1000))}s` : '';
      lines.push(`mode: ${w.mode ?? '(none)'} localTeam: ${w.localTeam ?? '-'}${w.playbackMode ? ' PLAYBACK' : ''}${clock}`);
      if (w.teamScores) lines.push(`teamScores: alpha=${w.teamScores.alpha} bravo=${w.teamScores.bravo}`);
      if (w.ffaScores?.size) lines.push(`ffaScores: ${[...w.ffaScores.entries()].map(([id, s]) => `${id.replace('bot:', '')}=${s}`).join(' ')}`);
    }
    lines.push(`remotes: ${ctx.remotePlayers.size} rendered / ${wire.size} known`);
    for (const [id, ps] of wire) {
      const rp = ctx.remotePlayers.get(id);
      const renderD = rp ? Math.hypot(rp.position.x - ps.position.x, rp.position.y - ps.position.y, rp.position.z - ps.position.z) : -1;
      lines.push(`  wire ${id.slice(0, 20)} team=${ps.team ?? '-'} dead=${ps.isDead} hp=${ps.health} ping=${ps.ping ?? '?'} pos=${fmt(ps.position)}${rp ? ` renderΔ=${renderD.toFixed(1)}m` : ' NOT-RENDERED'}`);
    }
    // Rendered but absent from the wire roster — local bots, dummies,
    // stale ghosts the roster never told us about.
    for (const [id, rp] of ctx.remotePlayers) {
      if (wire.has(id)) continue;
      const team = (rp as { team?: string }).team;
      lines.push(`  local ${id.slice(0, 20)} team=${team ?? '-'} dead=${rp.isDead} pos=${fmt(rp.position)}`);
    }
    const tb = ctx.teamBots?.();
    if (tb) {
      const alive = tb.bots.filter(b => !b.isDead).length;
      lines.push(`teamBots: ${alive}/${tb.bots.length} alive over=${tb.over ?? '-'} score=${tb.scores.alpha}:${tb.scores.bravo} localTeam=${tb.teamOf.get('local') ?? '-'}`);
      for (const b of tb.bots) {
        lines.push(`  bot ${b.playerId.replace('bot:', '')} team=${b.team} dead=${b.isDead} hp=${b.botHp ?? '?'} pos=${fmt(b.position)}`);
      }
    }
    lines.push(
      `projectiles: ${ctx.projectiles.length} live`,
      `uptime: ${(performance.now() / 1000).toFixed(0)}s`,
    );
    return lines;
  });

  exposeDebugWindowFunctions(ctx);
}

function exposeDebugWindowFunctions(ctx: StateDebugContext): void {
  if (typeof window === 'undefined') return;
  const { networkManager, logger } = ctx;

  window.takeClientSnapshot = () => {
    const playerMap = new Map<string, Omit<EntityState, 'id'>>();
    const player = ctx.getPlayer();
    playerMap.set('local', {
      position: { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      velocity: { x: player.vel.x, y: player.vel.y, z: player.vel.z },
      health: player.health,
      isDead: player.isDead,
      rotation: { yaw: player.yaw, pitch: player.pitch }
    });

    for (const [id, rp] of ctx.remotePlayers) {
      playerMap.set(id, {
        position: { x: rp.position.x, y: rp.position.y, z: rp.position.z },
        velocity: { x: 0, y: 0, z: 0 },
        health: 100,
        isDead: rp.isDead || false,
        rotation: { yaw: rp.rotation.yaw, pitch: rp.rotation.pitch }
      });
    }

    const snapshot = StateSnapshot.create(playerMap, ctx.projectiles.map(p => ({
      id: p.serverProjectileId ?? `demo-${p.demoProjectileId}`,
      ownerId: p.isRemote ? 'remote' : ctx.networkManager.getLocalPlayerId(),
      position: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      velocity: { x: p.vel.x, y: p.vel.y, z: p.vel.z },
    })), 'client');
    StateSnapshot.save(snapshot);
    logger.info('Client snapshot taken');
    return snapshot;
  };

  window.requestServerSnapshot = () => {
    if (networkManager.isConnected()) {
      networkManager.sendSnapshotRequest();
      logger.info('Requested server snapshot');
    } else {
      logger.warn('Not connected - cannot request server snapshot');
    }
  };

  window.exportClientSnapshots = () => {
    StateSnapshot.exportSnapshots();
  };

  window.compareState = () => {
    if (!networkManager.isConnected()) {
      logger.warn('Not connected');
      return;
    }

    const clientSnapshot = window.takeClientSnapshot!();
    logger.info('Client snapshot hash:', clientSnapshot.hash);

    pendingServerSnapshot = (serverPlayers: SnapshotPlayer[], _timestamp: number) =>
      reportStateComparison(logger, clientSnapshot, serverPlayers);

    networkManager.sendSnapshotRequest();
    logger.info('CompareState: requested server snapshot, waiting for response...');
  };

  logger.info('Client snapshot functions available: takeClientSnapshot(), requestServerSnapshot(), compareState(), exportClientSnapshots()');
}
