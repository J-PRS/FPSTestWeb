// World wire handlers — gameState join/restore, admin mapUpdate, and the
// server-owned creature (ball) event channel.

import { buildStructures, buildArenaDome, clearArenaDome } from '../../world/mapStructures.js';
import type { StructureSpec, InteriorSpec } from '../../../../shared/mapSpec.js';
import { setAmbientCaps } from '../species/ambientCaps.js';
import { structureColliders } from '../../../../shared/ballSim.js';
import { ColliderIndex } from '../../../../shared/solidWorld.js';
import { Ball } from '../../entities/balls.js';
import { Projectile } from '../../projectiles/Projectile.js';
import type { GameStatePlayer, LocalPlayerState } from '../../../../shared/protocol.js';
import type { NetworkManager } from '../../networking/NetworkManager.js';
import type { NetCtx } from './ctx.js';
import { reconcileDeployables } from './deployables.js';
import { resolveServerEndpoints } from '../../networking/endpoints.js';
import { setBotStructureSpecs } from '../botBrain.js';
import type { DeployKind } from '../../../../shared/deployables.js';
import type { TeamId } from '../../../../shared/teams.js';
import { saveLastRoomMap } from './lastRoom.js';
import { applyTerrain, applyInteriors, type MapSnapshot } from './mapAssets.js';
// Boot/terrain machinery lives in mapAssets.js — re-exported so main.ts
// and lastRoom.ts keep a single import site.
export { firstTerrain, probeBootMap, bootPrimeTerrain } from './mapAssets.js';
export type { MapSnapshot } from './mapAssets.js';

export function wireWorld(ctx: NetCtx): void {
  const { deps, networkManager, chat } = ctx;
  const logger = deps.logger;

  // Server-owned creatures — events only; the client replays the shared
  // sim between segments.
  networkManager.onBallSpawn = (data) => {
    if (deps.world.playbackMode) return;
    deps.entities().netBallSpawn(data);
  };
  networkManager.onBallSegment = (data) => {
    if (deps.world.playbackMode) return;
    deps.entities().netBallSegment(data);
  };
  networkManager.onBallDie = (data) => {
    if (deps.world.playbackMode) return;
    deps.entities().netBallDie(data);
  };
  networkManager.onBallRoster = (data) => {
    if (deps.world.playbackMode) return;
    deps.entities().netBallRoster(data);
  };

  // Server-owned melee species — crawl* events drive netDriven Crawler
  // instances replaying shared/creatureSim.ts (see game/netCrawlers.ts).
  networkManager.onCrawlSpawn = (data) => {
    if (deps.world.playbackMode) return;
    deps.entities().netCrawlSpawn(data);
  };
  networkManager.onCrawlEvt = (data) => {
    if (deps.world.playbackMode) return;
    deps.entities().netCrawlEvt(data);
  };
  networkManager.onCrawlDie = (data) => {
    if (deps.world.playbackMode) return;
    deps.entities().netCrawlDie(data);
  };
  networkManager.onCrawlRoster = (data) => {
    if (deps.world.playbackMode) return;
    deps.entities().netCrawlRoster(data);
  };

  // Admin hot-reload — the room's map spec changed mid-match. Rebuild the
  // static geometry exactly like the join path does from gameState.
  networkManager.onMapUpdate = (map) => {
    buildStructures(map.structures ?? [], deps.lazyScene());
    Ball.colliders = structureColliders(map.structures);
    Ball.colliderIndex = Ball.colliders.length ? new ColliderIndex(Ball.colliders) : null;
    Projectile.solidColliders = Ball.colliders;
    Projectile.solidIndex = Ball.colliderIndex;
    deps.lazyPlayer().movement.setStructures(map.structures);
    setBotStructureSpecs(map.structures);
    if (map.arena) {
      buildArenaDome(map.arena, deps.lazyTerrain().getHeight(map.arena.x, map.arena.z), deps.lazyScene());
    } else {
      clearArenaDome(deps.lazyScene());
    }
    if (map.terrain) void applyTerrain(ctx, map.terrain, map.terrainTex, map.sky);
    void applyInteriors(ctx, map.interiors);
    void resolveServerEndpoints().then(({ httpUrl }) => saveLastRoomMap(httpUrl, map));
    chat.add(null, 'map updated by admin');
  };

  // Initial connection and reconnection — full roster + local restore.
  networkManager.onGameState = (players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; team?: TeamId; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; pickups?: { id: number; pos: { x: number; y: number; z: number }; kind?: import('../../../../shared/pickups.js').PickupKind }[]; flags?: { team: TeamId; pos: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; matchEndsAt?: number; respawnMs?: number; deployables?: { id: number; owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; team?: string }[]; map?: { mode?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string; terrainTex?: string; sky?: string; interiors?: InteriorSpec[] } }) => {
    logger.warn(`gameState room=${roomInfo?.room} mapKeys=${roomInfo?.map ? Object.keys(roomInfo.map).join(',') : 'none'}`);
    applyRoomInfo(ctx, players.length, roomInfo);
    if (localPlayerState) restoreLocalPlayer(ctx, localPlayerState);
  };
}

/** Room snapshot half of gameState — mode, team, scores, clock, map
 *  geometry, mid-flight pickups/flags. Pure world setup, no local player. */
function applyRoomInfo(ctx: NetCtx, playerCount: number, roomInfo?: Parameters<NonNullable<NetworkManager['onGameState']>>[2]): void {
  const { deps, networkManager } = ctx;
  if (!roomInfo) return;
  deps.world.mode = roomInfo.mode;
  applyMatchMeta(ctx, roomInfo);
  if (roomInfo.respawnMs) deps.world.respawnMs = roomInfo.respawnMs;
  announceRoom(ctx, playerCount, roomInfo);
  // Pickups still lying on the field when we (re)joined — the roster is
  // authoritative both ways: spawn what's there, drop ghosts whose
  // pickupGone we missed while disconnected.
  ctx.reconcilePickups(new Set((roomInfo.pickups ?? []).map(p => p.id)));
  for (const p of roomInfo.pickups ?? []) ctx.addPickup(p.id, p.pos, p.kind ?? 'gem');
  reconcileDeployables(ctx, roomInfo.deployables);
  applyMapSnapshot(ctx, roomInfo.map);
  // Remember this room's map — F5 boots straight into it while the
  // socket round-trips instead of flashing the default field.
  void resolveServerEndpoints().then(({ httpUrl }) => saveLastRoomMap(httpUrl, roomInfo.map));
  // Flags mid-flight when we joined — same path as a flagUpdate broadcast.
  // An empty/absent list on a room hop must also clear the old room's
  // banners and HUD chips, so fire it either way.
  networkManager.onFlagUpdate?.(roomInfo.flags ?? []);
}

type RoomInfo = Parameters<NonNullable<NetworkManager['onGameState']>>[2];

/** Match meta (team/scores/clock/board) — a room-scoped gameState is
 *  authoritative, so a hop that drops them clears rather than leaves the
 *  old match's residue. The `room` gate keeps offline modes (TeamBots
 *  localTeam) untouched: only the server sends a room name. */
function applyMatchMeta(ctx: NetCtx, roomInfo: RoomInfo): void {
  const { deps } = ctx;
  if (roomInfo?.room !== undefined) {
    deps.world.localTeam = roomInfo.team;
    deps.world.teamScores = roomInfo.scores ?? null;
    deps.world.ffaScores = new Map(Object.entries(roomInfo.ffaScores ?? {}));
    deps.world.matchEndsAt = roomInfo.matchEndsAt ?? null;
    return;
  }
  if (roomInfo?.team !== undefined) deps.world.localTeam = roomInfo.team;
  if (roomInfo?.scores) deps.world.teamScores = roomInfo.scores;
  if (roomInfo?.matchEndsAt) deps.world.matchEndsAt = roomInfo.matchEndsAt;
  if (roomInfo?.ffaScores) deps.world.ffaScores = new Map(Object.entries(roomInfo.ffaScores));
}

/** Chat lines summarizing what we just joined — clock, room, team, board. */
function announceRoom(ctx: NetCtx, playerCount: number, roomInfo?: RoomInfo): void {
  const { chat } = ctx;
  if (roomInfo?.matchEndsAt) {
    const leftMin = Math.max(0, Math.ceil((roomInfo.matchEndsAt - Date.now()) / 60000));
    chat.add(null, `match clock — ~${leftMin}m left${leftMin === 0 ? ' (overtime)' : ''}`);
  }
  if (roomInfo?.room && roomInfo.room !== 'default') {
    chat.add(null, `joined room '${roomInfo.room}'${roomInfo.mode ? ` (${roomInfo.mode})` : ''} — ${playerCount} other player(s)`);
  }
  if (roomInfo?.team) {
    chat.add(null, `you are on ${roomInfo.team.toUpperCase()}${roomInfo.scores ? ` — ALPHA ${roomInfo.scores.alpha} : BRAVO ${roomInfo.scores.bravo}` : ''}`);
  }
  if (roomInfo?.ffaScores && Object.keys(roomInfo.ffaScores).length) {
    const top = Object.entries(roomInfo.ffaScores).toSorted((a, b) => b[1] - a[1]).slice(0, 3);
    chat.add(null, `dm board — ${top.map(([id, s]) => `${id} ${s}`).join(' / ')}`);
  }
}

/** Structures, dome, and per-map species caps — shared by gameState's
 *  join path; mapUpdate handles the same rebuild itself since it always
 *  knows a spec exists. Clears rather than skips on absence: a room hop
 *  re-runs gameState, and the old room's geometry must not survive. */
function applyMapSnapshot(ctx: NetCtx, map?: MapSnapshot): void {
  const { deps } = ctx;
  buildStructures(map?.structures ?? [], deps.lazyScene());
  // Same collider list the server sims against — ball prediction
  // ricochets off structures identically instead of phasing through.
  Ball.colliders = structureColliders(map?.structures);
  Ball.colliderIndex = Ball.colliders.length ? new ColliderIndex(Ball.colliders) : null;
  Projectile.solidColliders = Ball.colliders;
  Projectile.solidIndex = Ball.colliderIndex;
  // Player collision — the move sim's solid layer must hold the same
  // pieces or every wall contact reads as a divergence.
  deps.lazyPlayer().movement.setStructures(map?.structures);
  setBotStructureSpecs(map?.structures);
  if (map?.arena) {
    buildArenaDome(map.arena, deps.lazyTerrain().getHeight(map.arena.x, map.arena.z), deps.lazyScene());
  } else {
    clearArenaDome(deps.lazyScene());
  }
  setAmbientCaps(map?.ambient);
  void applyTerrain(ctx, map?.terrain ?? null, map?.terrainTex, map?.sky);
  void applyInteriors(ctx, map?.interiors)
    .catch((e) => ctx.deps.logger.warn(`applyInteriors failed: ${e instanceof Error ? e.message : String(e)}`));
}

/** Local-player half of gameState — position/rotation/health restore on
 *  reconnect. Velocity only survives if gentle: the stored value is
 *  whatever the last packet before disconnect reported, and replaying a
 *  stale knockback vector on reload produced phantom launches. */
function restoreLocalPlayer(ctx: NetCtx, localPlayerState: LocalPlayerState): void {
  const { deps } = ctx;
  deps.logger.debug(`Restoring local player state from gameState: ${JSON.stringify(localPlayerState)}`);
  const player = deps.lazyPlayer();
  player.pos.set(localPlayerState.position.x, localPlayerState.position.y, localPlayerState.position.z);
  deps.setLastSentPos({ x: localPlayerState.position.x, y: localPlayerState.position.y, z: localPlayerState.position.z });
  player.yaw = localPlayerState.rotation.yaw;
  player.pitch = localPlayerState.rotation.pitch;

  const v = localPlayerState.velocity;
  if (v && Math.hypot(v.x, v.y, v.z) < 10) {
    player.vel.set(v.x, v.y, v.z);
  } else {
    player.vel.set(0, 0, 0);
  }

  player.health = localPlayerState.health;
  player.armor = localPlayerState.armor ?? 0;
  player.isDead = localPlayerState.isDead;
  player.syncMovement(); // reseat controller — restored pos/vel otherwise revert
  // A join reseat is a declared discontinuity like any respawn — without
  // it the first pos report can be judged a 50m+ jump, and the camera
  // spinout watchdog flags the spawn snap as a 100°+/frame flick.
  player.markTeleport();

  deps.lazyHud().setDeathOverlay(player.isDead);
  if (player.isDead) {
    deps.lazyHud().hide();
  } else {
    deps.lazyHud().show();
  }

  deps.logger.debug(`Player state restored from gameState - pos(${localPlayerState.position.x.toFixed(1)},${localPlayerState.position.y.toFixed(1)},${localPlayerState.position.z.toFixed(1)}) vel(${localPlayerState.velocity?.x.toFixed(1) || 0},${localPlayerState.velocity?.y.toFixed(1) || 0},${localPlayerState.velocity?.z.toFixed(1) || 0}) health:${localPlayerState.health} dead:${localPlayerState.isDead}`);
}

/** Apply the probed saved map once the net ctx exists — structures,
 *  arena, interiors, albedo, sky. gameState that follows re-applies the
 *  same map for free or corrects it outright. */
export function bootApplySavedMap(ctx: NetCtx, map: MapSnapshot | null): void {
  if (map) applyMapSnapshot(ctx, map);
}
