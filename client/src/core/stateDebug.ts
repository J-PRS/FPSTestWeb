// Client-side desync debugging: periodic state-hash comparison against the

// server, full snapshot diffs on mismatch, and window-scope debug functions

// (takeClientSnapshot / requestServerSnapshot / compareState / exportClientSnapshots).



import { Logger, type ChildLogger } from './Logger.js';

import { diagLines, fmt } from './diagDump.js';

import type * as THREE from 'three';

import { computeStateHash, replicaHash } from '../../../shared/stateHash.js';

import { WORLD_MODEL, kindFieldDiffs } from '../../../shared/worldModel.js';

import { Ball } from '../entities/balls.js';

import { StateSnapshot, type EntityState, type GameStateSnapshot } from './StateSnapshot.js';

import type { SnapshotPlayer } from '../../../shared/protocol.js';

import type { Player } from '../entities/Player.js';

import type { RemotePlayer } from '../entities/RemotePlayer.js';

import type { NetworkManager } from '../networking/NetworkManager.js';

import type { Projectile } from '../projectiles/Projectile.js';

import { seedReplicaState } from '../game/netMelee.js';

import { commitTarget } from '../../../shared/creatureSim.js';

// the diff fires before any health-bearing tick record lands. Track

// 100 — young until the first real echo arrives.

const healthSeen = new Set<string>();



export interface StateDebugContext {

  networkManager: NetworkManager;

  getPlayer(): Player;

  remotePlayers: Map<string, RemotePlayer> & { remove?(id: string): boolean };

  projectiles: Projectile[];

  getLastSentPos(): { x: number; y: number; z: number };

  /** Match state — mode/team/scores/playback, for the diagnostics dump. */

  world?: { mode?: string; localTeam?: string; teamScores?: { alpha: number; bravo: number } | null; ffaScores?: Map<string, number>; matchEndsAt?: number | null; playbackMode?: boolean; flagStates?: Record<string, 'home' | 'carried' | 'dropped' | undefined>; flagMarkers?: Map<string, { carrier: string | null }>; netPickups?: Map<number, { kind: string }> };

  /** Offline bot referee — bot roster/teams for the diagnostics dump. */

  teamBots?: () => { bots: { playerId: string; team: string; isDead: boolean; position: { x: number; y: number; z: number }; botHp?: number }[]; teamOf: Map<string, string>; over: string | null; scores: { alpha: number; bravo: number }; ffaScores: Map<string, number> } | null;

  /** First-person viewmodel for the vm row in the diagnostics dump —
   *  group+mesh visibility answers "where's my gun" in one line. */

  viewModel?: { group: { visible: boolean }; activeWeapon: number; weapons: Map<number, { visible: boolean }> };

  /** Scene + view camera for the crosshair aim probe (what's under the reticle). */

  getScene?: () => THREE.Scene | null;

  getCamera?: () => THREE.Camera | null;

  /** Net-driven creature replicas (crawler/scarab/rakk/…) for the

   *  §4.7 fidelity hash — sim carries species/state/targetId. */

  netCreatures?: () => Iterable<{ netId: number; dead: boolean; uber: boolean; sim: { species: string; state: string; targetId: string | null; tx: number; ty: number; tz: number; tgtValid: boolean } | null }>;

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



/** One lane of the §4.7 fidelity check. Roster extraction and detail

 *  formatting stay per-kind (semantic payload); the compare → streak →

 *  report loop is shared so a fix lands on every lane at once — the

 *  five hand-copied loops used to drift a fix into one lane and let it

 *  re-bloom on the next. */

interface ReplicaLane {

  streak: number;

  /** id+field keys diffed on the previous check — perKey lanes only. */

  prevKeys: Set<string>;

}



function laneCheck(lane: ReplicaLane, logger: ChildLogger, a: {

  name: string;

  tick: number;

  serverHash: string;

  localHash: string;

  /** Everything past the hashes: roster ids + per-field diffs. */

  detail: string;

  /** Diff keys from kindFieldDiffs — perKey lanes escalate on repeats. */

  diffKeys?: Set<string> | null;

  /** Same-id+field persistence instead of streak — for lanes whose

   *  derived fields churn at integrator boundaries (balls). */

  perKey?: boolean;

  warnWhy: string;

  transientWhy: string;

}): boolean {

  if (a.localHash === a.serverHash) {

    lane.streak = 0;

    lane.prevKeys.clear();

    return false;

  }

lane.streak += 1;

  const detail = `server=${a.serverHash} client=${a.localHash} ${a.detail}`;

  let persistent = lane.streak >= 2;

  let persistDesc = `across ${lane.streak} checks`;

  if (a.perKey) {

    const stuck = a.diffKeys ? [...a.diffKeys].filter((k): boolean => lane.prevKeys.has(k)) : [];

    if (a.diffKeys) {lane.prevKeys = a.diffKeys;}

    persistent = stuck.length > 0 || (!a.diffKeys && lane.streak >= 2);

    persistDesc = stuck.length > 0 ? stuck.slice(0, 6).join(', ') : persistDesc;

  }

  if (persistent) {

    logger.warn(`[StateHash] ${a.name} DESYNC tick=${a.tick} ${detail} (persistent ${persistDesc} — ${a.warnWhy})`);

  } else {

    logger.debug(`[StateHash] ${a.name} mismatch tick=${a.tick} ${detail} (transient — ${a.transientWhy})`);

  }

  return persistent;

}



declare global {

  interface Window {

    takeClientSnapshot?: () => GameStateSnapshot;

    requestServerSnapshot?: () => void;

    exportClientSnapshots?: () => void;

    compareState?: () => void;

  }

}



function hashableEntry(

  rp: RemotePlayer | undefined,

  playerData: { position?: { x: number; y: number; z: number }; health?: number; isDead?: boolean; posAt?: number } | undefined,

): { x: number; y: number; z: number; health: number; isDead: boolean; posAt?: number } | null {

  const p = playerData?.position ?? rp?.position;

  if (!p) {return null;}

  return {

    x: p.x, y: p.y, z: p.z,

    health: playerData?.health ?? 100,

    isDead: playerData?.isDead ?? rp?.isDead ?? false,

    posAt: playerData?.posAt,

  };

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

// first-seen wall time; ids younger than the window aren't diffed.

const firstSeenAt = new Map<string, number>();

const JOIN_GRACE_MS = 1500;

// Respawn is a second join race for the echo channel: a dead→alive flip

// restarts the health echo (server writes 300, client still holds the

// pre-death or fabricated value until the next record lands). And a

// player whose records never carried health yet hashes the fabricated

const deadState = new Map<string, boolean>();



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



function youngId(id: string): boolean {

  const t = firstSeenAt.get(id);

  return t !== undefined && Date.now() - t < JOIN_GRACE_MS;

}



function diffPlayerFields(

  id: string,

  cp: { x: number; y: number; z: number; health: number; isDead: boolean; posAt?: number },

  sp: { position: { x: number; y: number; z: number }; health: number; isDead: boolean },

  healthDriftIds: string[],

  deadDriftIds: string[],

  posDriftIds: string[],

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

    // Fresh-record desync counts toward the warn streak; a record stale
    // >1.5s against a fresh snapshot is wire starvation, not divergence.
    if (cp.posAt === undefined || Date.now() - cp.posAt < 1500) {posDriftIds.push(id);}

  }

  // echo channel: a live heal window is stale-low by up to an echo

  // interval (~2hp) when the snapshot lands — real desyncs are >=9hp.

  if (Math.abs(cp.health - sp.health) > HEALTH_TOLERANCE) {

    diffs.push(`[echo] Player ${id} health: client=${cp.health} server=${sp.health}`);

    healthDriftIds.push(id);

  }

  if (cp.isDead !== sp.isDead) {

    diffs.push(`[edge] Player ${id} isDead: client=${cp.isDead} server=${sp.isDead}`);

    deadDriftIds.push(id);

  }

  return diffs;

}





// Diff client-side player state against a server snapshot; returns significant diffs.

function diffServerSnapshot(

  serverPlayers: SnapshotPlayer[],

  clientPlayers: Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>,

): { diffs: string[]; healthDriftIds: string[]; deadDriftIds: string[]; memberDriftIds: string[]; posDriftIds: string[] } {

  const serverMap = new Map<string, SnapshotPlayer>();

  for (const p of serverPlayers) {

    serverMap.set(p.id, p);

  }



  const diffs: string[] = [];

  const allIds = new Set([...serverMap.keys(), ...clientPlayers.keys()]);

  const healthDriftIds: string[] = [];

  const deadDriftIds: string[] = [];

  const memberDriftIds: string[] = [];

  const posDriftIds: string[] = [];



  for (const id of allIds) {

    const cp = clientPlayers.get(id);

    const sp = serverMap.get(id);



    if (!cp || !sp) {

      if (cp !== sp) {

        diffs.push(`Player ${id} on ${cp ? 'client but not server' : 'server but not client'}`);

        memberDriftIds.push(id);

      }

      continue;

    }

    // A just-joined remote diffs its default record against a mutated

    // server state — the join race, not desync. Roster-level mismatches

    // (missing on one end) still count; those have no grace story.

    if (youngId(id)) {continue;}



    diffs.push(...diffPlayerFields(id, cp, sp, healthDriftIds, deadDriftIds, posDriftIds));

  }

  return { diffs, healthDriftIds, deadDriftIds, memberDriftIds, posDriftIds };

}



/** Health is an echo field under combat — a remote taking hits mutates

 *  faster than the ~2Hz echo interval, so in-flight deltas read as

 *  "desync" on every snapshot while none is. Lag self-resolves; a

 *  dropped event never does (the diff pass adopts server hp, so a real

 *  loss keeps diverging next check). Persistence — same id divergent on

 *  consecutive detailed checks — is the desync signal; a lone sighting

 *  is in-flight traffic, logged at debug. */

const healthDriftStreak = new Map<string, number>();

const deadDriftStreak = new Map<string, number>();

const memberDriftStreak = new Map<string, number>();

const posDriftStreak = new Map<string, number>();

const DRIFT_STREAK_WARN = 2;



// Same streak rule for any echo-flavored field: persistence (same id on

// consecutive detailed checks) is the desync signal; a lone sighting is

// in-flight traffic or a heal the same snapshot already applied.

function noteDrift(streaks: Map<string, number>, driftIds: string[]): { persistentIds: Set<string>; transientCount: number } {

  const drifting = new Set(driftIds);

  const persistentIds = new Set<string>();

  for (const id of driftIds) {

    const streak = (streaks.get(id) ?? 0) + 1;

    streaks.set(id, streak);

    if (streak >= DRIFT_STREAK_WARN) {persistentIds.add(id);}

  }

  for (const id of streaks.keys()) {

    if (!drifting.has(id)) {streaks.delete(id);}

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

): { hashMatch: boolean; playerDifferences: string[]; projectileDifferences: string[]; } {

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



function exposeDebugWindowFunctions(ctx: StateDebugContext): void {

  if (typeof window === 'undefined') {return;}

  const { networkManager, logger } = ctx;



  window.takeClientSnapshot = (): GameStateSnapshot => {

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



  window.requestServerSnapshot = (): void => {

    if (networkManager.isConnected()) {

      networkManager.sendSnapshotRequest();

      logger.info('Requested server snapshot');

    } else {

      logger.warn('Not connected - cannot request server snapshot');

    }

  };



  window.exportClientSnapshots = (): void => {

    StateSnapshot.exportSnapshots();

  };



  window.compareState = (): void => {

    if (!networkManager.isConnected()) {

      logger.warn('Not connected');

      return;

    }



    const clientSnapshot = window.takeClientSnapshot!();

    logger.info('Client snapshot hash:', clientSnapshot.hash);



    pendingServerSnapshot = (serverPlayers: SnapshotPlayer[], _timestamp: number): { hashMatch: boolean; playerDifferences: string[]; projectileDifferences: string[]; } =>

      reportStateComparison(logger, clientSnapshot, serverPlayers);



    networkManager.sendSnapshotRequest();

    logger.info('CompareState: requested server snapshot, waiting for response...');

  };



  logger.info('Client snapshot functions available: takeClientSnapshot(), requestServerSnapshot(), compareState(), exportClientSnapshots()');

}





// Wire the onSnapshot/onStateHash handlers and expose window debug functions.

// Call once after networkManager exists (post-init).

/** Alt+Q header registration — runs on every host (the dump is the
 *  bug-report surface, not a dev hook); wireStateDebug calls it too. */
export function wireDiagHeader(ctx: StateDebugContext): void {
  Logger.setDiagnostics((verbose: boolean): string[] => diagLines(ctx, verbose));
}

export function wireStateDebug(ctx: StateDebugContext): void {

  const { networkManager, logger } = ctx;



  networkManager.onSnapshot = (players: SnapshotPlayer[], timestamp: number): void => {

    if (pendingServerSnapshot) {

      pendingServerSnapshot(players, timestamp);

      pendingServerSnapshot = null;

    }

  };



  // Auto state hash comparison

  let hashCheckCount = 0;

  let hashMismatchCount = 0;

  let lastSnapshotRequest = 0;

  // §4.7 fidelity lanes — one streak per kind (§ ReplicaLane). The ball

  // lane is perKey: enraged/targetId are DERIVED inside the replayed

  // integrator, so a bounce landing one tick either side of the enrage

  // boundary flips the flag transiently on a different ball each check —

  // a fleet streak of rotating offenders is churn, not a stranded replica.

  // Only a diff pinned to the same id+field twice running is real.

  const flagLane: ReplicaLane = { streak: 0, prevKeys: new Set() };

  const pickupLane: ReplicaLane = { streak: 0, prevKeys: new Set() };

  const deployLane: ReplicaLane = { streak: 0, prevKeys: new Set() };

  const creatureLane: ReplicaLane = { streak: 0, prevKeys: new Set() };

  const ballLane: ReplicaLane = { streak: 0, prevKeys: new Set() };



  networkManager.onStateHash = (serverHash: string, tick: number, playerCount: number, _timestamp: number, replica?: Record<string, { hash: string; fields?: unknown[][] } | undefined>): void => {

    // During demo playback the world shows the replay, not the live wire —

    // every lane would compare server truth against the recorded past and

    // report phantom desyncs.

    if (ctx.world?.playbackMode) {return;}

hashCheckCount += 1;

    // A persistent lane desync earns a world-state replay, not just a

    // warn — snapshotRequest now re-streams flag/pickup/deploy/ball/

    // crawler rosters server-side, so stuck lanes can converge back.

    let laneNeedsHeal = false;

    // Lane payloads unpack once at the edge — declared field order, so

    // each tuple is cast at the lane it belongs to.

    const serverFlagHash = replica?.flag?.hash;

    const serverPickupHash = replica?.pickup?.hash;

    const serverDeployHash = replica?.deploy?.hash;

    const serverCreatureHash = replica?.creature?.hash;

    const serverBallHash = replica?.ball?.hash;

    const serverCreatureFields = replica?.creature?.fields as [number, string, string, boolean, string | null][] | undefined;

    const serverDeployFields = replica?.deploy?.fields as [number, string, string, string][] | undefined;

    const serverBallFields = replica?.ball?.fields as [number, number, boolean, string | null][] | undefined;



    if (serverFlagHash !== undefined && ctx.world) {

      const local = new Map<string, { state: string; carrier: string | null }>();

      for (const [team, state] of Object.entries(ctx.world.flagStates ?? {})) {

        if (state) {local.set(team, { state, carrier: ctx.world.flagMarkers?.get(team)?.carrier ?? null });}

      }

      laneNeedsHeal ||= laneCheck(flagLane, logger, {

        name: 'FLAG', tick,

        serverHash: serverFlagHash,

        localHash: replicaHash(WORLD_MODEL.flag!, local),

        detail: `states=${JSON.stringify(Object.fromEntries([...local].map(([t, f]): [string, string] => [t, `${f.state}:${f.carrier ?? '-'}`])))}`,

        warnWhy: 'a flagUpdate edge never landed',

        transientWhy: 'flagUpdate in flight',

      });

    }



    if (serverPickupHash !== undefined && ctx.world) {

      const local = new Map<number, { kind: string }>();

      for (const [id, p] of ctx.world.netPickups ?? []) {local.set(id, { kind: p.kind });}

      laneNeedsHeal ||= laneCheck(pickupLane, logger, {

        name: 'PICKUP', tick,

        serverHash: serverPickupHash,

        localHash: replicaHash(WORLD_MODEL.pickup!, local),

        detail: `ids=[${[...local.keys()].join(',')}]`,

        warnWhy: 'a pickupSpawn/pickupGone edge never landed',

        transientWhy: 'spawn/collect edge in flight',

      });

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

      // The hash alone can't say WHAT diverged — diff the server's

      // per-id roster so the warn names the entry: a server-only id is

      // a missed spawn edge, a client-only id a missed deployGone, and

      // a field diff is a kind/owner/team asymmetry. Generated from the

      // deploy declaration so emit and diff can't drift apart.

      let detail = `ids=[${[...local.keys()].join(',')}]`;

      if (serverDeployFields) {

        const d = kindFieldDiffs(WORLD_MODEL.deploy!, local, serverDeployFields);

        if (d.diffs.length > 0) {detail += ` diffs={${d.diffs.slice(0, 6).join(', ')}}`;}

      }

      laneNeedsHeal ||= laneCheck(deployLane, logger, {

        name: 'DEPLOY', tick,

        serverHash: serverDeployHash,

        localHash: replicaHash(WORLD_MODEL.deploy!, local),

        detail,

        warnWhy: 'a deploySpawn/deployGone edge never landed',

        transientWhy: 'spawn/gone edge in flight',

      });

    }



    if (serverCreatureHash !== undefined && ctx.netCreatures) {

      const local = new Map<number, { species: string; state: string; uber: boolean; targetId: string | null }>();

      const creatureById = new Map<number, { sim: { state: string; targetId: string | null; tx: number; ty: number; tz: number; tgtValid: boolean } | null }>();

      for (const c of ctx.netCreatures()) {

        if (c.netId && !c.dead && c.sim) {

          local.set(c.netId, { species: c.sim.species, state: c.sim.state, uber: c.uber, targetId: c.sim.targetId });

          creatureById.set(c.netId, c);

        }

      }

      const localCreatureHash = replicaHash(WORLD_MODEL.creature!, local);

      // The hash alone can't say WHAT diverged — with the server's

      // per-id fields attached, name it (e.g. state drift vs a stranded

      // targetId) so the next soak answers instead of asking. Generated

      // from the creature declaration, so emit and diff can't drift apart.

      let detail = `ids=[${[...local.keys()].join(',')}]`;

      let creatureDiffKeys: Set<string> | null = null;

      if (localCreatureHash !== serverCreatureHash && serverCreatureFields) {

        const d = kindFieldDiffs(WORLD_MODEL.creature!, local, serverCreatureFields);

        if (d.diffs.length > 0) {detail += ` diff=${d.diffs.slice(0, 6).join(' ')}`;}

        creatureDiffKeys = new Set(d.diffs);

        // Heal field-level drift the way the snapshot heals player

        // liveness: a lost crawlEvt leaves sim.state/targetId stale

        // forever (the audit just re-warns). Edges stay the primary

        // writer — this only corrects ones that never landed.

        // Species is constructor-fixed; a mismatch there stays a warn.

        for (const [id, , state, , targetId] of serverCreatureFields) {

          const c = creatureById.get(id);

          if (c?.sim && (c.sim.state !== state || (c.sim.targetId ?? null) !== (targetId ?? null))) {

            seedReplicaState(c.sim, state);

            // Healing the label alone left the replica's committed aim
            // point stale — stepTotemAim keeps relocating off it, so the
            // replica re-blinks on its own clock and the same diff
            // re-warns forever. Clearing the commit idles it until a
            // real edge re-commits a target.
            commitTarget(c.sim, targetId ?? null, null);

          }

        }

      }

      laneNeedsHeal ||= laneCheck(creatureLane, logger, {

        name: 'CREATURE', tick,

        serverHash: serverCreatureHash,

        localHash: localCreatureHash,

        detail,

        // Creature labels cycle every ~1-2s (aim→charge→blink, orbit→dive

        // →climb), so snapshot checks legitimately catch mid-transition

        // states — a fleet streak is phase noise, not a strand. perKey

        // warns only when the same id+field+values repeat (the diff key

        // includes the value pair, so healthy cycling stays quiet).

        perKey: true,

        diffKeys: creatureDiffKeys,

        warnWhy: 'stranded or stale replica',

        transientWhy: 'lifecycle edge in flight',

      });

    }



    if (serverBallHash !== undefined) {

      const localBalls = new Map<number, { variant: number; enraged: boolean; targetId: string | null }>();

      for (const b of Ball.live) {

        // Committed wire regime (last applied segment), NOT live replay

        // state — b.enraged is re-derived by our own integrator each tick

        // and can never match the authority's derivation tick-for-tick.

        if (b.netDriven && !b.dead && b.netId) {localBalls.set(b.netId, { variant: b.variant, enraged: b.netS.netEnraged, targetId: b.netS.netTargetId });}

      }

      const localBallHash = replicaHash(WORLD_MODEL.ball!, localBalls);

      // Membership alone isn't the signal here — enraged/targetId churn

      // mismatches the hash on identical rosters, so diff the server's

      // per-id fields like the creature/deploy lanes do. Generated from

      // the ball declaration, so emit and diff can't drift apart.

      let detail = `ids=[${[...localBalls.keys()].join(',')}]`;

      let diffKeys: Set<string> | null = null;

      if (localBallHash !== serverBallHash && serverBallFields) {

        const d = kindFieldDiffs(WORLD_MODEL.ball!, localBalls, serverBallFields);

        diffKeys = d.keys;

        if (d.diffs.length > 0) {detail += ` diff=${d.diffs.slice(0, 6).join(' ')}`;}

      }

      laneNeedsHeal ||= laneCheck(ballLane, logger, {

        name: 'BALL', tick,

        serverHash: serverBallHash,

        localHash: localBallHash,

        detail,

        diffKeys,

        perKey: true,

        warnWhy: 'stranded or stale replica',

        transientWhy: 'lifecycle edge or derived-flag boundary in flight',

      });

    }



    // Object lanes have no other request path: the player-hash branch

    // below only fires when the PLAYER hash mismatches, so a persistent

    // flag/pickup/deploy/ball/creature desync could warn forever without

    // ever pulling the roster replay that heals it. Same cooldown —

    // one request heals every lane at once.

    if (laneNeedsHeal && Date.now() - lastSnapshotRequest >= SNAPSHOT_COOLDOWN_MS) {

      lastSnapshotRequest = Date.now();

      networkManager.sendSnapshotRequest();

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



hashMismatchCount += 1;

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



    pendingServerSnapshot = (serverPlayers: SnapshotPlayer[], _ts: number): void => {

      const { diffs, healthDriftIds, deadDriftIds, memberDriftIds, posDriftIds } = diffServerSnapshot(serverPlayers, clientPlayers);

      const { persistentIds, transientCount } = noteDrift(healthDriftStreak, healthDriftIds);

      const { persistentIds: persistentDeadIds, transientCount: transientDeadCount } = noteDrift(deadDriftStreak, deadDriftIds);

      const { persistentIds: persistentMemberIds } = noteDrift(memberDriftStreak, memberDriftIds);

      const { persistentIds: persistentPosIds } = noteDrift(posDriftStreak, posDriftIds);

      // Transient health sightings stay out of the warn — a first-seen

      // [echo] diff is expected while combat is in flight. An [edge]

      // isDead sighting is usually the liveness heal itself firing (the

      // same snapshot that flags it also flips it back) — only a flip

      // that persists across checks is real desync. Membership gaps are

      // the same shape: a join/leave edge racing the roster heals via

      // upsert/remoteDelete in this very pass.

      const significantDiffs = diffs.filter((d): boolean => {

        const h = /^\[echo\] Player (\S+) health/.exec(d);

        if (h) {return persistentIds.has(h[1]!);}

        const e = /^\[edge\] Player (\S+) isDead/.exec(d);

        if (e) {return persistentDeadIds.has(e[1]!);}

        const m = /^Player (\S+) on (?:server but not client|client but not server)/.exec(d);

        if (m) {return persistentMemberIds.has(m[1]!);}

        // [sim] position diffs get the same streak gate — a fast mover
        // on a tier-delayed record legitimately exceeds 50m for one
        // check; only a delta that survives consecutive snapshots is
        // a stranded replica. The snapshot heal above still runs.
        const s = /^\[sim\] Player (\S+) position/.exec(d);

        if (s) {return persistentPosIds.has(s[1]!);}

        return true;

      });



      // Heal on ANY diff, warned or not — a transient isDead flip filtered

      // out of the warn still needs this pass to converge, or it keeps

      // diverging until another diff happens to trigger the block.

      if (diffs.length > 0) {

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

          logger.debug(`[StateHash] Hash mismatch tick=${tick}: ${transientCount} health echo(s) + ${transientDeadCount} liveness flip(s) in flight, no persistent diffs (combat lag)`);

        }

        // Heal health divergence — the checker used to warn forever while

        // a silently-dropped hit left local hp divergent for the session.

        // Position stays correction-owned, isDead stays event-owned.

        const localId = networkManager.getLocalPlayerId();

        const player = ctx.getPlayer();

        for (const sp of serverPlayers) {

          if (sp.id === localId) {

            // The hash snapshot is a tick-interval stale — applying it
            // over an event-driven write (playerHit/yourHealth <1s ago)
            // resurrects the older hp, then the next echo 'drops' it
            // back and warns. Fresh events win; the heal only patches
            // drift older than the snapshot window itself.
            const hashHealthFresh = Date.now() - networkManager.lastHealthEventAt < 1000;
            if (!player.isDead && !hashHealthFresh && Number.isFinite(sp.health) && Math.abs(player.health - sp.health) > 0.5) {player.health = sp.health;}
            // Position is correction-owned — corrections answer position
            // claims, but a hidden/idle client sends none (still-throttle
            // floor is 4Hz; >10s silent means the channel is dead and no
            // correction can ever fire). A >30m delta with dead sends is
            // unhealable any other way: snap like a late respawn edge.
            // lastSentPos is the hashed value (player.pos mirrors it per
            // tick) — reading it here diffs the same coordinate the
            // mismatch was raised on.
            const sentPos = ctx.getLastSentPos();
            if (Number.isFinite(sp.position.x + sp.position.y + sp.position.z)) {
              const dist = Math.hypot(sentPos.x - sp.position.x, sentPos.y - sp.position.y, sentPos.z - sp.position.z);
              if (dist > 30 && Date.now() - networkManager.lastPositionSendTime > 10_000 && player.pos) {
                player.pos.set(sp.position.x, sp.position.y, sp.position.z);
                player.syncMovement();
                player.markTeleport();
                logger.warn('[StateHash] local pos snapped to server truth', { dist: Math.round(dist), at: sp.position });
              }
            }

            continue;

          }

          const cp = clientPlayers.get(sp.id);

          // Missing-member heal — a join edge lost before we ever saw the

          // player leaves them hashing "server but not client" forever:

          // nothing else mints the roster record. Seed it from snapshot

          // truth; the first-seen-update path spawns the entity when the

          // next live record lands (dead members stay unspawned by design).

          if (!cp && Number.isFinite(sp.position.x + sp.position.y + sp.position.z + sp.health)) {

            networkManager.upsertRemotePlayer(sp.id, {

              position: sp.position,

              health: sp.health,

              isDead: sp.isDead,

            });

          }

          if (cp && Number.isFinite(sp.health) && Math.abs(cp.health - sp.health) > 0.5) {networkManager.healRemoteHealth(sp.id, sp.health);}

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

        // Mirror-direction heal: a roster entry the server no longer has

        // (lost playerLeft) warns "client but not server" on every check

        // forever. The snapshot is the membership authority — retire both

        // the record and the entity.

        const serverIds = new Set(serverPlayers.map((sp): string => sp.id));

        for (const id of clientPlayers.keys()) {

          if (id === localId || serverIds.has(id)) {continue;}

          networkManager.remoteDelete(id);

          ctx.remotePlayers.remove?.(id);

        }

      } else {

        logger.info(`[StateHash] Hash mismatch tick=${tick} but positions within tolerance (network lag)`);

      }

    };

  };



  // Alt+Q/export header — live game state for bug reports. Keyed toward

  // "why didn't X happen" questions: death/respawn state, connection health,

  // what the server thinks vs what we have.

  wireDiagHeader(ctx);



  exposeDebugWindowFunctions(ctx);

}

