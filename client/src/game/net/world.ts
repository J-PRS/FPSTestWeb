// World wire handlers — gameState join/restore, admin mapUpdate, and the
// server-owned creature (ball) event channel.

import * as THREE from 'three';
import { buildStructures, buildArenaDome, clearArenaDome } from '../../world/mapStructures.js';
import type { StructureSpec } from '../../../../shared/mapSpec.js';
import { setAmbientCaps } from '../species/ambientCaps.js';
import { structureColliders } from '../../../../shared/ballSim.js';
import { ColliderIndex } from '../../../../shared/solidWorld.js';
import { Ball } from '../../entities/balls.js';
import { Projectile } from '../../projectiles/Projectile.js';
import type { GameStatePlayer, LocalPlayerState } from '../../../../shared/protocol.js';
import type { NetworkManager } from '../../networking/NetworkManager.js';
import type { NetCtx } from './ctx.js';
import { loadHeightfieldBin, loadHeightmap } from '../../world/heightmap.js';
import { reconcileDeployables } from './deployables.js';
import { resolveServerEndpoints } from '../../networking/endpoints.js';
import { setBotStructureSpecs } from '../botBrain.js';

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
    chat.add(null, 'map updated by admin');
  };

  // Initial connection and reconnection — full roster + local restore.
  networkManager.onGameState = (players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; team?: 'alpha' | 'bravo'; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; pickups?: { id: number; pos: { x: number; y: number; z: number }; kind?: import('../../../../shared/pickups.js').PickupKind }[]; flags?: { team: 'alpha' | 'bravo'; pos: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; matchEndsAt?: number; respawnMs?: number; deployables?: { id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone' | 'shield'; pos: { x: number; y: number; z: number }; team?: string }[]; map?: { mode?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string; terrainTex?: string; sky?: string } }) => {
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
    const top = Object.entries(roomInfo.ffaScores).toSorted((a, b) => b[1] - a[1]).slice(0, 3);
    chat.add(null, `dm board — ${top.map(([id, s]) => `${id} ${s}`).join(' / ')}`);
  }
}

type MapSnapshot = { structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string; terrainTex?: string; sky?: string };

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
}

/** Fetch the room's heightfield and swap the live terrain over to it.
 *  Serializes concurrent loads — a mapUpdate racing a re-join can't
 *  finish out of order and leave the older field resident. */
let terrainSwap: Promise<void> = Promise.resolve();
let terrainActive: string | null = null;
// Rooms without a spec terrain reset to the boot field — the PNG the
// session loaded at startup.
const BOOT_HEIGHTMAP = '/assets/heightmaps/test_vertex.png';
async function applyTerrain(ctx: NetCtx, file: string | null, texPath?: string, skyDir?: string): Promise<void> {
  const key = `${file}|${texPath}|${skyDir}`;
  if (terrainActive === key) return;
  const { deps } = ctx;
  terrainSwap = terrainSwap.then(async () => {
    if (terrainActive === key) return;
    Ball.terrainSwapping = true;
    try {
      const { httpUrl } = await resolveServerEndpoints();
      if (file) {
        await loadHeightfieldBin(`${httpUrl}/maps/${file}`);
      } else {
        await loadHeightmap(BOOT_HEIGHTMAP);
      }
      deps.lazyTerrain().reloadHeightmap();
      // Ball.field captured the previous heightfield OBJECT — hmData is
      // swapped, not mutated, so the sim would keep predicting bounces on
      // the old terrain. Re-read it now that the new field is resident.
      Ball.initNetMode(true);

      // Baked albedo (T2 ports) replaces the procedural palette entirely.
      // Isolated from the terrain swap: a missing texture shouldn't leave
      // the old heightfield-resident-but-unbuilt state behind.
      try {
        await applyTerrainTex(deps, httpUrl, texPath);
      } catch (e) {
        const src = (e as ProgressEvent)?.target as { src?: string } | undefined;
        deps.logger.warn(`Albedo load failed for ${texPath}: ${src?.src ?? String(e)}`);
      }
      // Cube skybox faces extracted as px/nx/py/ny/pz/nz.png; maps
      // without one fall back to the procedural atmosphere.
      await applySky(deps, httpUrl, skyDir);

      terrainActive = key;
      deps.logger.info(`Terrain swapped to maps/${file}`);
    } catch (e) {
      // THREE loaders reject with ProgressEvent (no .message) — log
      // whichever URL failed via the event target, plus Error message.
      const ev = e as ProgressEvent & { target?: { src?: string } };
      const detail = e instanceof Error ? e.message
        : ev?.target?.src ?? String(e);
      deps.logger.warn(`Terrain load failed for ${file ?? BOOT_HEIGHTMAP}: ${detail}`);
    } finally {
      Ball.terrainSwapping = false;
    }
  });
  return terrainSwap;
}

/** A missing face must not kill the terrain swap — loader rejections
 *  are ProgressEvents, which used to surface as "undefined" here. */
async function applySky(deps: NetCtx['deps'], httpUrl: string, skyDir: string | undefined): Promise<void> {
  const skyMesh = deps.lazyScene().getObjectByName('__sky');
  if (!skyDir) {
    deps.lazyScene().background = null;
    if (skyMesh) skyMesh.visible = true;
    return;
  }
  const order = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
    (f) => `${httpUrl}/maps/${skyDir}/${f}.png`);
  try {
    deps.lazyScene().background = await new THREE.CubeTextureLoader().loadAsync(order);
    if (skyMesh) skyMesh.visible = false;
  } catch (e) {
    const src = (e as ProgressEvent)?.target as { src?: string } | undefined;
    deps.logger.warn(`Sky load failed for ${skyDir}: ${src?.src ?? String(e)}`);
  }
}

/** Baked albedo + optional full-fidelity material layer (mats.json next
 *  to it on T2 ports). Missing mats just keeps the baked look. */
async function applyTerrainTex(deps: NetCtx['deps'], httpUrl: string, texPath: string | undefined): Promise<void> {
  const terrain = deps.lazyTerrain();
  if (!texPath) {
    terrain.setAlbedo(null);
    terrain.setMaterialBlend(null, null, null, 0);
    return;
  }
  const tex = await new THREE.TextureLoader().loadAsync(`${httpUrl}/maps/${texPath}`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  terrain.setAlbedo(tex);
  try {
    const mats = await loadMats(`${httpUrl}/maps/${texPath.slice(0, texPath.lastIndexOf('/'))}`);
    if (mats) terrain.setMaterialBlend(mats.tiles, mats.alphaA, mats.alphaB, mats.tileMeters);
  } catch {
    terrain.setMaterialBlend(null, null, null, 0);
  }
}

/** T2 material-blend manifest beside albedo.png: alphas.bin is
 *  grid²×count u8 weights packed into two RGBA DataTextures (8 max);
 *  the 256px tiles are drawn into a 4×2 atlas so a plain sampler2D can
 *  reach all layers. Returns null when no mats.json exists. */
async function loadMats(dirUrl: string): Promise<{
  tiles: THREE.Texture; alphaA: THREE.Texture; alphaB: THREE.Texture; tileMeters: number;
} | null> {
  const res = await fetch(`${dirUrl}/mats.json`);
  if (!res.ok) return null;
  const man = await res.json() as { grid: number; count: number; tiles: string[]; alphas: string; tileMeters: number };
  const raw = new Uint8Array(await (await fetch(`${dirUrl}/${man.alphas}`)).arrayBuffer());
  const grid = man.grid, count = man.count;
  const pack = (offset: number) => {
    const rgba = new Uint8Array(grid * grid * 4);
    for (let c = 0; c < 4; c++) {
      const layer = offset + c;
      if (layer >= count) break;
      const src = layer * grid * grid;
      for (let i = 0; i < grid * grid; i++) rgba[i * 4 + c] = raw[src + i];
    }
    const t = new THREE.DataTexture(rgba, grid, grid, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  // Tile atlas: 4×2 cells of 256px on one canvas — atlas UVs in the
  // shader do the layer select, no texture arrays needed.
  const atlas = document.createElement('canvas');
  atlas.width = 1024; atlas.height = 512;
  const g = atlas.getContext('2d')!;
  await Promise.all(man.tiles.slice(0, 8).map(async (path, k) => {
    const img = new Image();
    img.src = `${dirUrl}/${path}`;
    await img.decode();
    g.drawImage(img, (k % 4) * 256, Math.floor(k / 4) * 256, 256, 256);
  }));
  const tilesTex = new THREE.CanvasTexture(atlas);
  tilesTex.colorSpace = THREE.SRGBColorSpace;
  tilesTex.generateMipmaps = true;
  tilesTex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tiles: tilesTex, alphaA: pack(0), alphaB: pack(4), tileMeters: man.tileMeters };
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
