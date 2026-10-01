// Client-side desync debugging: periodic state-hash comparison against the
// server, full snapshot diffs on mismatch, and window-scope debug functions
// (takeClientSnapshot / requestServerSnapshot / compareState / exportClientSnapshots).

import Logger, { ChildLogger } from './Logger.js';
import { aimProbe } from './aimProbe.js';
import type * as THREE from 'three';
import { computeStateHash } from '../../../shared/stateHash.js';
import { StateSnapshot, type EntityState, type GameStateSnapshot } from './StateSnapshot.js';
import type { SnapshotPlayer } from '../../../shared/protocol.js';
import { WeaponType } from '../../../shared/weapons.js';
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
  /** Scene + view camera for the crosshair aim probe (what's under the reticle). */
  getScene?: () => THREE.Scene | null;
  getCamera?: () => THREE.Camera | null;
  logger: ChildLogger;
}

const SNAPSHOT_COOLDOWN_MS = 5000; // Don't request snapshots more often than every 5s
const POSITION_TOLERANCE = 50.0;   // Warn if position delta exceeds this (higher for async snapshot comparison)

let pendingServerSnapshot: ((players: SnapshotPlayer[], timestamp: number) => void) | null = null;

// Rolling battle log for the Alt+Q dump — every kill the wire reported,
// newest last. Capped so a long session doesn't grow it unboundedly.
const battleLog: string[] = [];
const BATTLE_LOG_MAX = 40;
const killName = (id: string) => id.replace(/^bot:/, '');

/** Called by the kill handler — "shooter killed target with weapon" lines
 *  for the diagnostics dump's battle-log section. */
export function noteKill(shooterId: string, targetId: string, weapon?: number): void {
  const w = weapon !== undefined && WeaponType[weapon] ? ` with ${WeaponType[weapon]}` : '';
  battleLog.push(`${killName(shooterId)} killed ${killName(targetId)}${w}`);
  if (battleLog.length > BATTLE_LOG_MAX) battleLog.splice(0, battleLog.length - BATTLE_LOG_MAX);
}

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
    allPlayers.set(id, hashableEntry(ctx.remotePlayers.get(id), playerData));
  }
  return allPlayers;
}

function hashableEntry(
  rp: RemotePlayer | undefined,
  playerData: { position?: { x: number; y: number; z: number }; health?: number; isDead?: boolean } | undefined,
): { x: number; y: number; z: number; health: number; isDead: boolean } {
  const p = playerData?.position ?? rp?.position ?? { x: 0, y: 0, z: 0 };
  return {
    x: p.x, y: p.y, z: p.z,
    health: playerData?.health ?? 100,
    isDead: playerData?.isDead ?? rp?.isDead ?? false,
  };
}

const fmt = (v: { x: number; y: number; z: number }) =>
  `(${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)})`;

/** Chrome-only JS heap gauge — absent in Firefox/Safari, so the line
 *  degrades to nothing instead of lying. */
function heapLine(): string {
  const m = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return m ? ` heap ${(m.usedJSHeapSize / 1048576).toFixed(0)}/${(m.jsHeapSizeLimit / 1048576).toFixed(0)}MB` : '';
}

function diagLines(ctx: StateDebugContext): string[] {
  const nm = ctx.networkManager;
  const p = ctx.getPlayer();
  const wire = nm.getPlayers();
  const lines: string[] = [
    `localId: ${nm.getLocalPlayerId()}`,
    `connected: ${nm.isConnected()} tier: ${nm.getTransportTier() ?? '-'} ping: ${nm.getPing()}ms loss: ${nm.getPacketLoss()}% jitter: ${nm.getJitter()}ms`,
    `net: up ${(nm.bandwidth().up / 1024).toFixed(1)}KB/s down ${(nm.bandwidth().down / 1024).toFixed(1)}KB/s${heapLine()}`,
    `local: dead=${p.isDead} hp=${p.health} pos=${fmt(p.pos)} vel=${fmt(p.vel)} yaw=${p.yaw.toFixed(2)} pitch=${p.pitch.toFixed(2)} onGround=${p.onGround}`,
    `lastSentPos: ${fmt(ctx.getLastSentPos())}`,
  ];
  pushWorld(lines, ctx.world);
  pushAimProbe(lines, ctx);
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
  pushBots(lines, ctx);
  lines.push(
    `projectiles: ${ctx.projectiles.length} live`,
    `uptime: ${(performance.now() / 1000).toFixed(0)}s`,
  );
  pushTrailCensus(lines, ctx);
  pushProjectiles(lines, ctx);
  if (battleLog.length) {
    lines.push('battleLog:');
    for (const k of battleLog.slice(-15)) lines.push(`  ${k}`);
  }
  return lines;
}

// Per-projectile row — pairs a dead trail with the shell that owns it.
// Ribbon health flags per lane: '!' stopped, 'L' lit on screen,
// '~N' pushes starved by the near-zero-velocity gate — a shell pushing
// every frame that still has count<2 is the silent no-trail case.
function pushProjectiles(lines: string[], ctx: StateDebugContext): void {
  let ribbonWarns = 0;
  for (const pr of ctx.projectiles) {
    const d = pr.dbg();
    const rib = d.ribbons.map(r => `${r.slot}:${r.count}${r.stopped ? '!' : ''}${r.lit ? 'L' : ''}${r.starved ? `~${r.starved}` : ''}`).join(',');
    if (d.ribbons.some(r => r.count < 2 && r.starved > 10)) ribbonWarns++;
    lines.push(`  proj ${pr.config.name} age=${pr.age.toFixed(2)}${pr.exploded ? ' EX' : ''} q=${JSON.stringify(d.trail)} rib=[${rib}]`);
  }
  if (ribbonWarns) lines.push(`ribbonWarns: ${ribbonWarns} projectiles emit pushes but have NO ribbon samples`);
}

// Crosshair probe near the top — the point of the dump is usually "what
// is THAT thing", so the answer shouldn't sit under the censuses.
function pushAimProbe(lines: string[], ctx: StateDebugContext): void {
  const aimScene = ctx.getScene?.(), aimCam = ctx.getCamera?.();
  if (!aimScene || !aimCam) return;
  try {
    const hits = aimProbe(aimScene, aimCam);
    lines.push(`aim: ${hits.length ? '' : '(no tagged object under crosshair)'}`);
    for (const h of hits) lines.push(`  ${h}`);
  } catch (e) {
    lines.push(`aim: probe failed ${(e as Error).message}`);
  }
}

// Sections self-register via registerDiag() in the owning modules —
// every field optional so a module that never loaded degrades to a
// missing line, not a thrown dump.
interface TrailDump {
  stats?: Record<string, number>;
  pools?: Record<string, unknown>;
  trails?: Record<string, unknown>[];
  ribbons?: Record<string, unknown>[];
  ribbonBatch?: unknown;
  ribbonOrphans?: { count: number; slots: number[]; rows: Record<string, unknown>[] };
  litAudit?: { lit: number; unowned: number[] };
  reapedLit?: number;
  inst?: unknown;
  swarm?: unknown;
  fx?: unknown;
}

// Trail census — dead-trail bugs need attached/particles/slot per live
// trail, not just the projectile count.
function pushTrailCensus(lines: string[], ctx: StateDebugContext): void {
  const td = window.__trailDump?.() as TrailDump | undefined;
  if (!td) return;
  if (td.stats) lines.push(`trailStats: ${Object.entries(td.stats).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (td.pools) lines.push(`pools: ${JSON.stringify(td.pools)}`);
  for (const t of td.trails ?? []) lines.push(`  trail ${JSON.stringify(t)}`);
  lines.push(`ribbons: ${td.ribbons?.length ?? 0} live ${JSON.stringify(td.ribbonBatch ?? null)}`);
  // Position-tagged rows — a frozen streak on screen maps to a slot by its
  // head/mid coords; sorted by fullness so the longest streaks lead.
  const rs = (td.ribbons ?? []).toSorted((a, b) => ((b.count as number) ?? 0) - ((a.count as number) ?? 0)).slice(0, 16);
  for (const r of rs) lines.push(`  rib ${JSON.stringify(r)}`);
  const orphans = td.ribbonOrphans;
  if (orphans && orphans.count > 0) {
    lines.push(`ribbonOrphans: ${orphans.count} (leaked slots: ${orphans.slots.length})`);
    for (const o of orphans.rows) lines.push(`  orphan ${JSON.stringify(o)}`);
  } else {
    lines.push('ribbonOrphans: 0');
  }
  pushTrailExtras(lines, td, ctx);
}

// The extras half of the trail census: GPU-buffer audits (lit-but-unowned
// slots — frozen streaks no RibbonTrail object owns, reapedLit counts the
// ones the sweeper already blacked out), instancing/species pool inventory,
// and the oldest-shell line that surfaces the next immortal early.
function pushTrailExtras(lines: string[], td: TrailDump, ctx: StateDebugContext): void {
  if (td.litAudit) {
    const unowned = td.litAudit.unowned;
    lines.push(`litAudit: lit=${td.litAudit.lit} unowned=${unowned.length}${unowned.length ? ' slots=[' + unowned.slice(0, 12).join(',') + (unowned.length > 12 ? ',…' : '') + ']' : ''} reaped=${td.reapedLit ?? 0}`);
  }
  if (td.inst) lines.push(`instPools: ${JSON.stringify(td.inst)}`);
  if (td.swarm) lines.push(`swarm: ${JSON.stringify(td.swarm)}`);
  if (td.fx) lines.push(`fx: ${JSON.stringify(td.fx)}`);
  const aged = ctx.projectiles.toSorted((a, b) => b.age - a.age).slice(0, 5);
  if (aged.length) {
    lines.push(`oldest: ${aged.map(pr => `${pr.config.name}@${pr.age.toFixed(1)}s(${pr.pos.x.toFixed(0)},${pr.pos.y.toFixed(0)},${pr.pos.z.toFixed(0)})`).join(' ')}`);
  }
  let offWorld = 0;
  for (const pr of ctx.projectiles) {
    if (pr.pos.y < -500 || Math.abs(pr.pos.x) > 4000 || Math.abs(pr.pos.z) > 4000) offWorld++;
  }
  if (offWorld) lines.push(`offWorld: ${offWorld} projectiles outside sane bounds`);
}

function pushWorld(lines: string[], w: StateDebugContext['world']): void {
  if (!w) return;
  const clock = w.matchEndsAt ? ` endsIn=${Math.max(0, Math.ceil((w.matchEndsAt - Date.now()) / 1000))}s` : '';
  lines.push(`mode: ${w.mode ?? '(none)'} localTeam: ${w.localTeam ?? '-'}${w.playbackMode ? ' PLAYBACK' : ''}${clock}`);
  if (w.teamScores) lines.push(`teamScores: alpha=${w.teamScores.alpha} bravo=${w.teamScores.bravo}`);
  if (w.ffaScores?.size) lines.push(`ffaScores: ${[...w.ffaScores.entries()].map(([id, s]) => `${id.replace('bot:', '')}=${s}`).join(' ')}`);
}

function pushBots(lines: string[], ctx: StateDebugContext): void {
  const tb = ctx.teamBots?.();
  if (!tb) return;
  const alive = tb.bots.filter(b => !b.isDead).length;
  lines.push(`teamBots: ${alive}/${tb.bots.length} alive over=${tb.over ?? '-'} score=${tb.scores.alpha}:${tb.scores.bravo} localTeam=${tb.teamOf.get('local') ?? '-'}`);
  for (const b of tb.bots) {
    lines.push(`  bot ${b.playerId.replace('bot:', '')} team=${b.team} dead=${b.isDead} hp=${b.botHp ?? '?'} sheep=${(b as { sheep?: number }).sheep ?? 0} pos=${fmt(b.position)}`);
  }
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
    // Print BOTH positions, not just the delta — a frozen delta means one
    // end parked (spawn/teleport desync), and you can't tell which end is
    // stranded without the coordinates.
    diffs.push(`Player ${id} position delta=(${dx.toFixed(1)},${dy.toFixed(1)},${dz.toFixed(1)}) client=${fmt(cp)} server=${fmt(sp.position)}`);
  }
  // Sub-1hp deltas are float dust (fractional regen ticks, armor soak
  // remainders) — a real desync is a whole hit or more.
  if (Math.abs(cp.health - sp.health) > 0.5) {
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

    // shared/stateHash.ts owns the algorithm on both ends — an FNV over
    // (id, rounded xyz, health, dead). The old client-side djb2 string
    // hash could NEVER equal the server's FNV, so every check here was a
    // phantom mismatch that spammed snapshot requests and desync warns.
    const localHashStr = computeStateHash(allPlayers);

    if (localHashStr === serverHash) {
      logger.debug(`[StateHash] OK tick=${tick} hash=${serverHash} players=${playerCount}`);
      return;
    }

    hashMismatchCount++;
    logger.debug(`[StateHash] MISMATCH tick=${tick} server=${serverHash} client=${localHashStr}`);
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
          // The last few health events often name the culprit directly —
          // a kill with no respawn following, a hit that never landed.
          recentEvents: networkManager.recentEvents().slice(-8),
        });
      } else {
        logger.info(`[StateHash] Hash mismatch tick=${tick} but positions within tolerance (network lag)`);
      }
    };
  };

  // Alt+Q/export header — live game state for bug reports. Keyed toward
  // "why didn't X happen" questions: death/respawn state, connection health,
  // what the server thinks vs what we have.
  Logger.setDiagnostics(() => diagLines(ctx));

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
