// Client-side desync debugging: periodic state-hash comparison against the
// server, full snapshot diffs on mismatch, and window-scope debug functions
// (takeClientSnapshot / requestServerSnapshot / compareState / exportClientSnapshots).

import type { ChildLogger } from './Logger.js';
import Logger from './Logger.js';
import { diagLines, fmt } from './diagDump.js';
import type * as THREE from 'three';
import { computeStateHash, computeReplicaHash, computeCreatureHash, computeDeployHash, computeFlagHash, computePickupHash } from '../../../shared/stateHash.js';
import { Ball } from '../entities/balls.js';
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
  world?: { mode?: string; localTeam?: string; teamScores?: { alpha: number; bravo: number } | null; ffaScores?: Map<string, number>; matchEndsAt?: number | null; playbackMode?: boolean; flagStates?: Record<string, 'home' | 'carried' | 'dropped' | undefined>; flagMarkers?: Map<string, { carrier: string | null }>; netPickups?: Map<number, { kind: string }> };
  /** Offline bot referee — bot roster/teams for the diagnostics dump. */
  teamBots?: () => { bots: { playerId: string; team: string; isDead: boolean; position: { x: number; y: number; z: number }; botHp?: number }[]; teamOf: Map<string, string>; over: string | null; scores: { alpha: number; bravo: number }; ffaScores: Map<string, number> } | null;
  /** Scene + view camera for the crosshair aim probe (what's under the reticle). */
  getScene?: () => THREE.Scene | null;
  getCamera?: () => THREE.Camera | null;
  /** Net-driven creature replicas (crawler/scarab/rakk/…) for the
   *  §4.7 fidelity hash — sim carries species/state/targetId. */
  netCreatures?: () => Iterable<{ netId: number; dead: boolean; uber: boolean; sim: { species: string; state: string; targetId: string | null } | null }>;
  /** Wire-id → deployable pairs (remote spawns + own plants with a
   *  serverId) for the §4.7 deployable fidelity hash. */
  netDeployables?: () => Iterable<[number, { kind: string; owner?: string; team?: string; dead: boolean }]>;
  logger: ChildLogger;
}

const SNAPSHOT_COOLDOWN_MS = 5000; // Don't request snapshots more often than every 5s
// Per-channel audit tolerances (shared/stateHash.ts FIELD_CHANNELS):
//   sim  — position is async-snapshot comparison, 50m = obvious parking
//   echo — health lags by up to one ~2Hz echo interval during heals
const POSITION_TOLERANCE = 50;
const HEALTH_TOLERANCE = 2;

let pendingServerSnapshot: ((players: SnapshotPlayer[], timestamp: number) => void) | null = null;

// Alt+Q dump + battle log moved to diagDump.ts — noteKill re-exported
// here so the kill handlers' import site stays stable.
export { noteKill } from './diagDump.js';

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
    if (id === ctx.networkManager.getLocalPlayerId()) {continue;} // Skip local player
    const entry = hashableEntry(ctx.remotePlayers.get(id), playerData);
    // No data = don't hash a FABRICATED player — a phantom (0,0,0)/100hp
    // entry used to hide a genuinely missing replica behind a "server
    // also has them" false match. Omitting the id makes the roster
    // difference itself the signal; the audit reports it verbatim.
    if (entry) {
      allPlayers.set(id, entry);
      noteEchoRace(id, entry.isDead, playerData?.health, Date.now());
    }
  }
  return allPlayers;
}

// Join race: a fresh remote's first record defaults health to 100 while
// the server already hashes their real (regen/damage-mutated) value —
// the diff fires before any health-bearing tick record lands. Track
// first-seen wall time; ids younger than the window aren't diffed.
const firstSeenAt = new Map<string, number>();
const JOIN_GRACE_MS = 1500;
// Respawn is a second join race for the echo channel: a dead→alive flip
// restarts the health echo (server writes 300, client still holds the
// pre-death or fabricated value until the next record lands). And a
// player whose records never carried health yet hashes the fabricated
// 100 — young until the first real echo arrives.
const deadState = new Map<string, boolean>();
const healthSeen = new Set<string>();

function noteSeenIds(ids: Iterable<string>): void {
  const now = Date.now();
  const live = new Set(ids);
  for (const id of live) {
    if (!firstSeenAt.has(id)) {firstSeenAt.set(id, now);}
  }
  for (const id of firstSeenAt.keys()) {
    if (!live.has(id)) {firstSeenAt.delete(id); deadState.delete(id); healthSeen.delete(id);}
  }
}

/** Echo-channel grace events observed per player while building the map:
 *  dead flips and "health still fabricated" both re-arm the join window. */
function noteEchoRace(id: string, isDead: boolean, health: number | undefined, now: number): void {
  if (deadState.get(id) !== isDead) {
    deadState.set(id, isDead);
    firstSeenAt.set(id, now);
  }
  if (health === undefined && !healthSeen.has(id)) {
    firstSeenAt.set(id, now);
  } else if (health !== undefined) {
    healthSeen.add(id);
  }
}

function youngId(id: string): boolean {
  const t = firstSeenAt.get(id);
  return t !== undefined && Date.now() - t < JOIN_GRACE_MS;
}

function hashableEntry(
  rp: RemotePlayer | undefined,
  playerData: { position?: { x: number; y: number; z: number }; health?: number; isDead?: boolean } | undefined,
): { x: number; y: number; z: number; health: number; isDead: boolean } | null {
  const p = playerData?.position ?? rp?.position;
  if (!p) {return null;}
  return {
    x: p.x, y: p.y, z: p.z,
    health: playerData?.health ?? 100,
    isDead: playerData?.isDead ?? rp?.isDead ?? false,
  };
}

// Diff client-side player state against a server snapshot; returns significant diffs.
function diffServerSnapshot(
  serverPlayers: SnapshotPlayer[],
  clientPlayers: Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>,
): { diffs: string[]; healthDriftIds: string[] } {
  const serverMap = new Map<string, SnapshotPlayer>();
  for (const p of serverPlayers) {
    serverMap.set(p.id, p);
  }

  const diffs: string[] = [];
  const allIds = new Set([...serverMap.keys(), ...clientPlayers.keys()]);
  const healthDriftIds: string[] = [];

  for (const id of allIds) {
    const cp = clientPlayers.get(id);
    const sp = serverMap.get(id);

    if (!cp || !sp) {
      if (cp !== sp) {diffs.push(`Player ${id} on ${cp ? 'client but not server' : 'server but not client'}`);}
      continue;
    }
    // A just-joined remote diffs its default record against a mutated
    // server state — the join race, not desync. Roster-level mismatches
    // (missing on one end) still count; those have no grace story.
    if (youngId(id)) {continue;}

    diffs.push(...diffPlayerFields(id, cp, sp, healthDriftIds));
  }
  return { diffs, healthDriftIds };
}

function diffPlayerFields(
  id: string,
  cp: { x: number; y: number; z: number; health: number; isDead: boolean },
  sp: { position: { x: number; y: number; z: number }; health: number; isDead: boolean },
  healthDriftIds: string[],
): string[] {
  const diffs: string[] = [];
  const dx = Math.abs(cp.x - sp.position.x);
  const dy = Math.abs(cp.y - sp.position.y);
  const dz = Math.abs(cp.z - sp.position.z);
  if (Math.max(dx, dy, dz) > POSITION_TOLERANCE) {
    // Print BOTH positions, not just the delta — a frozen delta means one
    // end parked (spawn/teleport desync), and you can't tell which end is
    // stranded without the coordinates.
    diffs.push(`[sim] Player ${id} position delta=(${dx.toFixed(1)},${dy.toFixed(1)},${dz.toFixed(1)}) client=${fmt(cp)} server=${fmt(sp.position)}`);
  }
  // echo channel: a live heal window is stale-low by up to an echo
  // interval (~2hp) when the snapshot lands — real desyncs are >=9hp.
  if (Math.abs(cp.health - sp.health) > HEALTH_TOLERANCE) {
    diffs.push(`[echo] Player ${id} health: client=${cp.health} server=${sp.health}`);
    healthDriftIds.push(id);
  }
  if (cp.isDead !== sp.isDead) {
    diffs.push(`[edge] Player ${id} isDead: client=${cp.isDead} server=${sp.isDead}`);
  }
  return diffs;
}

/** Health is an echo field under combat — a remote taking hits mutates
 *  faster than the ~2Hz echo interval, so in-flight deltas read as
 *  "desync" on every snapshot while none is. Lag self-resolves; a
 *  dropped event never does (the diff pass adopts server hp, so a real
 *  loss keeps diverging next check). Persistence — same id divergent on
 *  consecutive detailed checks — is the desync signal; a lone sighting
 *  is in-flight traffic, logged at debug. */
const healthDriftStreak = new Map<string, number>();
const DRIFT_STREAK_WARN = 2;

function noteHealthDrift(driftIds: string[]): { persistentIds: Set<string>; transientCount: number } {
  const drifting = new Set(driftIds);
  const persistentIds = new Set<string>();
  for (const id of driftIds) {
    const streak = (healthDriftStreak.get(id) ?? 0) + 1;
    healthDriftStreak.set(id, streak);
    if (streak >= DRIFT_STREAK_WARN) persistentIds.add(id);
  }
  for (const id of healthDriftStreak.keys()) {
    if (!drifting.has(id)) healthDriftStreak.delete(id);
  }
  return { persistentIds, transientCount: drifting.size - persistentIds.size };
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
  // Ball replica-fidelity streak — the fleet hash covers identity and
  // mirrored lifecycle fields (variant/enraged/targetId). A transition
  // in flight can land across a check boundary, so one sighting is
  // debug-level; a persistent mismatch means a stranded/lost/stale
  // replica the ballRoster path never healed (§4.7).
  let ballDriftStreak = 0;
  let creatureDriftStreak = 0;
  let deployDriftStreak = 0;
  let flagDriftStreak = 0;
  let pickupDriftStreak = 0;

  networkManager.onStateHash = (serverHash: string, tick: number, playerCount: number, _timestamp: number, serverBallHash?: string, serverCreatureHash?: string, serverDeployHash?: string, serverFlagHash?: string, serverPickupHash?: string, serverCreatureFields?: [number, string, string, boolean, string | null][]) => {
    hashCheckCount++;

    if (serverFlagHash !== undefined && ctx.world) {
      const local = new Map<string, { state: string; carrier: string | null }>();
      for (const [team, state] of Object.entries(ctx.world.flagStates ?? {})) {
        if (state) {local.set(team, { state, carrier: ctx.world.flagMarkers?.get(team)?.carrier ?? null });}
      }
      const localFlagHash = computeFlagHash(local);
      if (localFlagHash === serverFlagHash) {
        flagDriftStreak = 0;
      } else {
        flagDriftStreak++;
        const detail = `server=${serverFlagHash} client=${localFlagHash} states=${JSON.stringify(Object.fromEntries([...local].map(([t, f]) => [t, `${f.state}:${f.carrier ?? '-'}`])))}`;
        if (flagDriftStreak >= 2) {
          logger.warn(`[StateHash] FLAG DESYNC tick=${tick} ${detail} (persistent across ${flagDriftStreak} checks — a flagUpdate edge never landed)`);
        } else {
          logger.debug(`[StateHash] flag mismatch tick=${tick} ${detail} (transient — flagUpdate in flight)`);
        }
      }
    }

    if (serverPickupHash !== undefined && ctx.world) {
      const local = new Map<number, { kind: string }>();
      for (const [id, p] of ctx.world.netPickups ?? []) {local.set(id, { kind: p.kind });}
      const localPickupHash = computePickupHash(local);
      if (localPickupHash === serverPickupHash) {
        pickupDriftStreak = 0;
      } else {
        pickupDriftStreak++;
        const detail = `server=${serverPickupHash} client=${localPickupHash} ids=[${[...local.keys()].join(',')}]`;
        if (pickupDriftStreak >= 2) {
          logger.warn(`[StateHash] PICKUP DESYNC tick=${tick} ${detail} (persistent across ${pickupDriftStreak} checks — a pickupSpawn/pickupGone edge never landed)`);
        } else {
          logger.debug(`[StateHash] pickup mismatch tick=${tick} ${detail} (transient — spawn/collect edge in flight)`);
        }
      }
    }

    if (serverDeployHash !== undefined && ctx.netDeployables) {
      const local = new Map<number, { kind: string; owner: string; team: string }>();
      for (const [id, d] of ctx.netDeployables()) {
        // Hash inputs must mirror the server's semantics exactly — it
        // feeds raw fields with '' for missing, never fabricated values:
        // a teamless base asset hashed localTeam client-side vs ''
        // server-side is a permanent false desync (the soak's ids=[2]).
        if (!d.dead) {local.set(id, { kind: d.kind, owner: d.owner ?? '', team: d.team ?? '' });}
      }
      const localDeployHash = computeDeployHash(local);
      if (localDeployHash === serverDeployHash) {
        deployDriftStreak = 0;
      } else {
        deployDriftStreak++;
        const detail = `server=${serverDeployHash} client=${localDeployHash} ids=[${[...local.keys()].join(',')}]`;
        if (deployDriftStreak >= 2) {
          logger.warn(`[StateHash] DEPLOY DESYNC tick=${tick} ${detail} (persistent across ${deployDriftStreak} checks — a deploySpawn/deployGone edge never landed)`);
        } else {
          logger.debug(`[StateHash] deploy mismatch tick=${tick} ${detail} (transient — spawn/gone edge in flight)`);
        }
      }
    }

    if (serverCreatureHash !== undefined && ctx.netCreatures) {
      const local = new Map<number, { species: string; state: string; uber: boolean; targetId: string | null }>();
      for (const c of ctx.netCreatures()) {
        if (c.netId && !c.dead && c.sim) {local.set(c.netId, { species: c.sim.species, state: c.sim.state, uber: c.uber, targetId: c.sim.targetId });}
      }
      const localCreatureHash = computeCreatureHash(local);
      if (localCreatureHash === serverCreatureHash) {
        creatureDriftStreak = 0;
      } else {
        creatureDriftStreak++;
        // The hash alone can't say WHAT diverged — with the server's
        // per-id fields attached, name it (e.g. state drift vs a
        // stranded targetId) so the next soak answers instead of asking.
        let detail = `server=${serverCreatureHash} client=${localCreatureHash} ids=[${[...local.keys()].join(',')}]`;
        if (serverCreatureFields) {
          const diffs: string[] = [];
          for (const [id, species, state, uber, targetId] of serverCreatureFields) {
            const l = local.get(id);
            if (!l) { diffs.push(`#${id}:missing`); continue; }
            const f: string[] = [];
            if (l.species !== species) {f.push(`species ${l.species}/${species}`);}
            if (l.state !== state) {f.push(`state ${l.state}/${state}`);}
            if (l.uber !== uber) {f.push(`uber`);}
            if ((l.targetId ?? null) !== (targetId ?? null)) {f.push(`tgt ${l.targetId ?? '-'}/${targetId ?? '-'}`);}
            if (f.length) {diffs.push(`#${id}:${f.join(',')}`);}
          }
          for (const id of local.keys()) {
            if (!serverCreatureFields.some((r) => r[0] === id)) {diffs.push(`#${id}:stranded`);}
          }
          if (diffs.length) {detail += ` diff=${diffs.slice(0, 6).join(' ')}`;}
        }
        if (creatureDriftStreak >= 2) {
          logger.warn(`[StateHash] CREATURE DESYNC tick=${tick} ${detail} (persistent across ${creatureDriftStreak} checks — stranded or stale replica)`);
        } else {
          logger.debug(`[StateHash] creature mismatch tick=${tick} ${detail} (transient — lifecycle edge in flight)`);
        }
      }
    }

    if (serverBallHash !== undefined) {
      const localBalls = new Map<number, { variant: number; enraged: boolean; targetId: string | null }>();
      for (const b of Ball.live) {
        if (b.netDriven && !b.dead && b.netId) {localBalls.set(b.netId, { variant: b.variant, enraged: b.enraged, targetId: b.netS.netTargetId });}
      }
      const localBallHash = computeReplicaHash(localBalls);
      if (localBallHash === serverBallHash) {
        ballDriftStreak = 0;
      } else {
        ballDriftStreak++;
        const detail = `server=${serverBallHash} client=${localBallHash} ids=[${[...localBalls.keys()].join(',')}]`;
        if (ballDriftStreak >= 2) {
          logger.warn(`[StateHash] BALL DESYNC tick=${tick} ${detail} (persistent across ${ballDriftStreak} checks — stranded or stale replica)`);
        } else {
          logger.debug(`[StateHash] ball mismatch tick=${tick} ${detail} (transient — lifecycle edge in flight)`);
        }
      }
    }

    const allPlayers = buildHashablePlayerMap(ctx);
    noteSeenIds(allPlayers.keys());

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
      const { diffs, healthDriftIds } = diffServerSnapshot(serverPlayers, clientPlayers);
      const { persistentIds, transientCount } = noteHealthDrift(healthDriftIds);
      // Transient health sightings stay out of the warn — a first-seen
      // [echo] diff is expected while combat is in flight. Everything
      // else (sim/edge diffs, persistent health drift) reports as before.
      const significantDiffs = diffs.filter(d => {
        const m = /^\[echo\] Player (\S+) health/.exec(d);
        return !m || persistentIds.has(m[1]!);
      });

      if (significantDiffs.length > 0) {
        logger.warn(`[StateHash] DESYNC DETECTED tick=${tick} hash=${serverHash} vs ${localHashStr} | ${significantDiffs.join('; ')}`, {
          checks: hashCheckCount,
          mismatches: hashMismatchCount,
          matchRate: `${((1 - hashMismatchCount / hashCheckCount) * 100).toFixed(1)}%`,
          // The last few health events often name the culprit directly —
          // a kill with no respawn following, a hit that never landed.
          recentEvents: networkManager.recentEvents().slice(-8),
        });
        // Heal health divergence — the checker used to warn forever while
        // a silently-dropped hit left local hp divergent for the session.
        // Position stays correction-owned, isDead stays event-owned.
        const localId = networkManager.getLocalPlayerId();
        const player = ctx.getPlayer();
        for (const sp of serverPlayers) {
          if (sp.id === localId) {
            if (!player.isDead && Math.abs(player.health - sp.health) > 0.5) {player.health = sp.health;}
            continue;
          }
          const cp = clientPlayers.get(sp.id);
          if (cp && Math.abs(cp.health - sp.health) > 0.5) {networkManager.healRemoteHealth(sp.id, sp.health);}
          // Liveness heal — kill/respawn events muted by a resync gap or
          // dropped elsewhere leave isDead divergent forever (health heals
          // above, the flag itself never did). Server owns liveness; mirror
          // the flip into the entity so visuals follow the roster.
          if (cp && cp.isDead !== sp.isDead) {
            const flip = networkManager.healRemoteLife(sp.id, sp.isDead, sp.health, sp.position);
            const rp = ctx.remotePlayers.get(sp.id);
            if (flip === 'revived') {rp?.respawn(sp.position);}
            else if (flip === 'killed') {rp?.playDeath();}
          }
        }
      } else if (transientCount > 0) {
        logger.debug(`[StateHash] Hash mismatch tick=${tick}: ${transientCount} in-flight health echo(s), no persistent diffs (combat lag)`);
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
  if (typeof window === 'undefined') {return;}
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
      // Health lives in NetworkManager's player map, not on the render
      // replica — hashing a hardcoded 100 made every compareState report
      // show remote health as fiction.
      const data = ctx.networkManager.getPlayers().get(id);
      playerMap.set(id, {
        position: { x: rp.position.x, y: rp.position.y, z: rp.position.z },
        velocity: { x: 0, y: 0, z: 0 },
        health: data?.health ?? 100,
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
