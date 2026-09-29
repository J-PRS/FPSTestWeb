// World wire handlers — gameState join/restore, admin mapUpdate, and the
// server-owned creature (ball) event channel.

import { buildStructures, buildArenaDome, clearArenaDome } from '../../world/mapStructures.js';
import type { StructureSpec } from '../../../../shared/mapSpec.js';
import { setAmbientCaps } from '../species/ambientCaps.js';
import { structureColliders } from '../../../../shared/ballSim.js';
import { Ball } from '../../entities/balls.js';
import { Projectile } from '../../projectiles/Projectile.js';
import type { GameStatePlayer, LocalPlayerState } from '../../../../shared/protocol.js';
import type { NetworkManager } from '../../networking/NetworkManager.js';
import type { NetCtx } from './ctx.js';
import { loadHeightfieldBin, loadHeightmap } from '../../world/heightmap.js';
import { reconcileDeployables } from './deployables.js';
import { resolveServerEndpoints } from '../../networking/endpoints.js';

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
    Projectile.solidColliders = Ball.colliders;
    deps.lazyPlayer().movement.setStructures(map.structures);
    if (map.arena) {
      buildArenaDome(map.arena, deps.lazyTerrain().getHeight(map.arena.x, map.arena.z), deps.lazyScene());
    } else {
      clearArenaDome(deps.lazyScene());
    }
    if (map.terrain) void applyTerrain(ctx, map.terrain);
    chat.add(null, 'map updated by admin');
  };

  // Initial connection and reconnection — full roster + local restore.
  networkManager.onGameState = (players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; team?: 'alpha' | 'bravo'; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; pickups?: { id: number; pos: { x: number; y: number; z: number }; kind?: import('../../../../shared/pickups.js').PickupKind }[]; flags?: { team: 'alpha' | 'bravo'; pos: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; matchEndsAt?: number; respawnMs?: number; deployables?: { id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone'; pos: { x: number; y: number; z: number } }[]; map?: { mode?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string } }) => {
    logger.debug(`gameState received, players: ${players.length}`);
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
    // Sort mutates the (already fresh) entries array — toSorted isn't in
    // this tsconfig's lib target, so the unicorn suggestion can't apply.
    const top = Object.entries(roomInfo.ffaScores).sort((a, b) => b[1] - a[1]).slice(0, 3);
    chat.add(null, `dm board — ${top.map(([id, s]) => `${id} ${s}`).join(' / ')}`);
  }
}

type MapSnapshot = { structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string };

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
  Projectile.solidColliders = Ball.colliders;
  // Player collision — the move sim's solid layer must hold the same
  // pieces or every wall contact reads as a divergence.
  deps.lazyPlayer().movement.setStructures(map?.structures);
  if (map?.arena) {
    buildArenaDome(map.arena, deps.lazyTerrain().getHeight(map.arena.x, map.arena.z), deps.lazyScene());
  } else {
    clearArenaDome(deps.lazyScene());
  }
  setAmbientCaps(map?.ambient);
  if (map?.terrain) void applyTerrain(ctx, map.terrain);
  else void applyTerrain(ctx, null);
}

/** Fetch the room's heightfield and swap the live terrain over to it.
 *  Serializes concurrent loads — a mapUpdate racing a re-join can't
 *  finish out of order and leave the older field resident. */
let terrainSwap: Promise<void> = Promise.resolve();
let terrainActive: string | null = null;
// Rooms without a spec terrain reset to the boot field — the PNG the
// session loaded at startup.
const BOOT_HEIGHTMAP = '/assets/heightmaps/test_vertex.png';
async function applyTerrain(ctx: NetCtx, file: string | null): Promise<void> {
  if (terrainActive === file) return;
  const { deps } = ctx;
  terrainSwap = terrainSwap.then(async () => {
    if (terrainActive === file) return;
    try {
      if (file) {
        const { httpUrl } = await resolveServerEndpoints();
        await loadHeightfieldBin(`${httpUrl}/maps/${file}`);
      } else {
        await loadHeightmap(BOOT_HEIGHTMAP);
      }
      deps.lazyTerrain().reloadHeightmap();
      // Ball.field captured the previous heightfield OBJECT — hmData is
      // swapped, not mutated, so the sim would keep predicting bounces on
      // the old terrain. Re-read it now that the new field is resident.
      Ball.initNetMode(true);
      terrainActive = file;
      deps.logger.info(`Terrain swapped to maps/${file}`);
    } catch (e) {
      deps.logger.warn(`Terrain load failed for maps/${file}: ${(e as Error).message}`);
    }
  });
  return terrainSwap;
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

  deps.lazyHud().setDeathOverlay(player.isDead);
  if (player.isDead) {
    deps.lazyHud().hide();
  } else {
    deps.lazyHud().show();
  }

  deps.logger.debug(`Player state restored from gameState - pos(${localPlayerState.position.x.toFixed(1)},${localPlayerState.position.y.toFixed(1)},${localPlayerState.position.z.toFixed(1)}) vel(${localPlayerState.velocity?.x.toFixed(1) || 0},${localPlayerState.velocity?.y.toFixed(1) || 0},${localPlayerState.velocity?.z.toFixed(1) || 0}) health:${localPlayerState.health} dead:${localPlayerState.isDead}`);
}
