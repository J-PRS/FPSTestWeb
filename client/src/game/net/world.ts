// World wire handlers — gameState join/restore, admin mapUpdate, and the
// server-owned creature (ball) event channel.

import * as THREE from 'three';
import { buildStructures, buildArenaDome, clearArenaDome } from '../../world/mapStructures.js';
import type { StructureSpec, InteriorSpec } from '../../../../shared/mapSpec.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { setAmbientCaps } from '../species/ambientCaps.js';
import { structureColliders } from '../../../../shared/ballSim.js';
import { ColliderIndex } from '../../../../shared/solidWorld.js';
import { Ball } from '../../entities/balls.js';
import { Projectile } from '../../projectiles/Projectile.js';
import type { GameStatePlayer, LocalPlayerState } from '../../../../shared/protocol.js';
import type { NetworkManager } from '../../networking/NetworkManager.js';
import { urlParams } from '../../core/params.js';
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
    void applyInteriors(ctx, map.interiors);
    chat.add(null, 'map updated by admin');
  };

  // Initial connection and reconnection — full roster + local restore.
  networkManager.onGameState = (players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; team?: 'alpha' | 'bravo'; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; pickups?: { id: number; pos: { x: number; y: number; z: number }; kind?: import('../../../../shared/pickups.js').PickupKind }[]; flags?: { team: 'alpha' | 'bravo'; pos: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; matchEndsAt?: number; respawnMs?: number; deployables?: { id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone' | 'shield'; pos: { x: number; y: number; z: number }; team?: string }[]; map?: { mode?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string; terrainTex?: string; sky?: string; interiors?: InteriorSpec[] } }) => {
    logger.warn(`gameState room=${roomInfo?.room} mapKeys=${roomInfo?.map ? Object.keys(roomInfo.map).join(',') : 'none'}`);
    applyRoomInfo(ctx, players.length, roomInfo);
    if (localPlayerState) restoreLocalPlayer(ctx, localPlayerState);
  };
}

// Canonical interior materials — dedup by stripped name (per-GLB `.NNN`
// suffixes removed) + the shading params that actually differ.
const _canonMats = new Map<string, { key: string; mat: THREE.Material }>();
function canonInteriorMat(mat: THREE.Material): { key: string; mat: THREE.Material } {
  const std = mat as THREE.MeshStandardMaterial;
  const key = [
    std.color ? std.color.getHexString() : '-',
    // Texture identity comes from the map's own name — two materials that
    // differ only in .name (the exporter's per-file .NNN suffixes already
    // stripped) render identically and can share one draw call.
    std.map ? std.map.name || 'tex' : '-',
    String(std.roughness ?? ''), String(std.metalness ?? ''),
    std.emissive ? std.emissive.getHexString() : '-',
    String(std.emissiveIntensity ?? ''),
    String(std.flatShading ?? ''), String(std.side ?? ''),
    std.transparent ? 't' : 'o',
  ].join('|');
  const hit = _canonMats.get(key);
  if (hit) return hit;
  // GLTFLoader gives every DIF interior MeshStandardMaterial — PBR shading
  // on ~85k tris while the whole rest of the world runs Lambert. Downgrade
  // here: interiors are static, unmapped geometry; Lambert keeps the same
  // maps/emissive/AO for a fraction of the fragment cost.
  let useMat: THREE.Material = mat;
  if (std.isMeshStandardMaterial) {
    const lam = new THREE.MeshLambertMaterial({
      color: std.color,
      map: std.map,
      emissive: std.emissive,
      emissiveMap: std.emissiveMap,
      emissiveIntensity: std.emissiveIntensity,
      normalMap: std.normalMap,
      aoMap: std.aoMap,
      aoMapIntensity: std.aoMapIntensity,
      transparent: std.transparent,
      opacity: std.opacity,
      side: std.side,
      alphaTest: std.alphaTest,
      depthWrite: std.depthWrite,
      flatShading: std.flatShading,
      vertexColors: std.vertexColors,
      fog: std.fog,
    });
    lam.name = std.name;
    useMat = lam;
  }
  const entry = { key, mat: useMat };
  _canonMats.set(key, entry);
  return entry;
}

// Interior parts worth a cast shadow: sized like architecture, not trim.
// Radius over ~4m — towers, walls, ramps. Small greebles would cost a
// draw call each in the shadow pass for an unreadable sliver of shade.
// Per-mesh radius is stashed on userData so the loop can distance-gate
// casting (geometry is world-baked — boundingSphere.center is the mesh's
// true position).
function interiorCastRadius(g: THREE.BufferGeometry): number {
  if (!g.boundingSphere) g.computeBoundingSphere();
  const r = g.boundingSphere?.radius ?? 0;
  return r > 4 ? r : 0;
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

type MapSnapshot = { structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string; terrainTex?: string; sky?: string; interiors?: InteriorSpec[] };

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

/** Fetch the room's heightfield and swap the live terrain over to it.
 *  Serializes concurrent loads — a mapUpdate racing a re-join can't
 *  finish out of order and leave the older field resident. */
let terrainSwap: Promise<void> = Promise.resolve();
let terrainActive: string | null = null;
/** Resolves when the first terrain decision lands — a room's map spec
 *  or confirmation that the boot field stays. Offline bot fill waits on
 *  this so it never seeds a roster on the wrong heightmap. */
let firstTerrainResolve!: () => void;
export const firstTerrain = new Promise<void>((r) => { firstTerrainResolve = r; });
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
      deps.world.onTerrainApplied?.(file);
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
      firstTerrainResolve();
    }
  });
  return terrainSwap;
}

// Exports are GL-layout (verified by _tools/tershot/seamcheck.py: py's
// four edges match all four side tops, side ring pairs at ~1 error).
// Sole export defect: px is written upside-down — its bottom edge matches
// the up face while every sibling matches via its top. Flip it on canvas.
const SKY_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
const SKY_VFLIP = new Set(['px']);

/** A missing face must not kill the terrain swap — loader rejections
 *  are ProgressEvents, which used to surface as "undefined" here. */
async function applySky(deps: NetCtx['deps'], httpUrl: string, skyDir: string | undefined): Promise<void> {
  const skyMesh = deps.lazyScene().getObjectByName('__sky');
  if (!skyDir) {
    deps.lazyScene().background = null;
    if (skyMesh) skyMesh.visible = true;
    return;
  }
  const order = SKY_FACES.map((f) => `${httpUrl}/maps/${skyDir}/${f}.png`);
  try {
    const loader = new THREE.ImageLoader();
    const faces = await Promise.all(order.map(async (url, i) => {
      const img = await loader.loadAsync(url);
      if (!SKY_VFLIP.has(SKY_FACES[i]!)) return img;
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.translate(0, img.height);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, 0);
      return c;
    }));
    const cube = new THREE.CubeTexture(faces);
    cube.colorSpace = THREE.SRGBColorSpace;
    cube.needsUpdate = true;
    deps.lazyScene().background = cube;
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
    terrain.setMaterialBlend(null, null, null, 0, null);
    return;
  }
  const tex = await new THREE.TextureLoader().loadAsync(`${httpUrl}/maps/${texPath}`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  terrain.setAlbedo(tex);
  try {
    const mats = urlParams.has('mats')
      ? await loadMats(`${httpUrl}/maps/${texPath.slice(0, texPath.lastIndexOf('/'))}`)
      : null;
    if (mats) terrain.setMaterialBlend(mats.tiles, mats.alphaA, mats.alphaB, mats.tileMeters, mats.means);
  } catch {
    terrain.setMaterialBlend(null, null, null, 0, null);
  }
}

// The shader compares sampled (linear-decoded) luminance against each
// tile's mean — compute that mean in linear space too or dark tiles
// divide by an sRGB mean ~2.4× too high and the blend reads as black grime.
function srgb2lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** T2 material-blend manifest beside albedo.png: alphas.bin is
 *  grid²×count u8 weights packed into two RGBA DataTextures (8 max);
 *  the 256px tiles are drawn into a 4×2 atlas so a plain sampler2D can
 *  reach all layers. Returns null when no mats.json exists. */
async function loadMats(dirUrl: string): Promise<{
  tiles: THREE.Texture; alphaA: THREE.Texture; alphaB: THREE.Texture; tileMeters: number;
  means: number[];
} | null> {
  const res = await fetch(`${dirUrl}/mats.json`);
  if (!res.ok) return null;
  const man = await res.json() as { grid: number; count: number; tiles: string[]; alphas: string; tileMeters: number };
  const raw = new Uint8Array(await (await fetch(`${dirUrl}/${man.alphas}`)).arrayBuffer());
  const grid = man.grid, count = man.count;
  // alphas.bin is cell-major: weights packed [cell*count + layer], not
  // [layer*grid² + cell]. Reading planar spreads every layer at ~0.25
  // over the whole map — the tiled detail covered the entire terrain.
  const pack = (offset: number) => {
    const rgba = new Uint8Array(grid * grid * 4);
    for (let c = 0; c < 4; c++) {
      const layer = offset + c;
      if (layer >= count) break;
      for (let i = 0; i < grid * grid; i++) rgba[i * 4 + c] = raw[i * count + layer];
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
  const means = Array.from({ length: 8 }, () => 0.5);
  await Promise.all(man.tiles.slice(0, 8).map(async (path, k) => {
    const img = new Image();
    // Cross-origin atlas bake — without this the canvas taints and
    // CanvasTexture's upload throws SecurityError (silent grey terrain).
    img.crossOrigin = 'anonymous';
    img.src = `${dirUrl}/${path}`;
    await img.decode();
    const cx = (k % 4) * 256, cy = Math.floor(k / 4) * 256;
    g.drawImage(img, cx, cy, 256, 256);
    // Per-tile mean luminance — the shader divides the blended detail by
    // the weighted mean so tiles modulate the albedo around their own
    // brightness instead of replacing its color (dark rock tiles used to
    // erase the grass bake outright).
    const d = g.getImageData(cx, cy, 256, 256).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.299 * srgb2lin(d[i]) + 0.587 * srgb2lin(d[i + 1]) + 0.114 * srgb2lin(d[i + 2]);
    means[k] = Math.max(s / (d.length / 4), 1e-3);
  }));
  const tilesTex = new THREE.CanvasTexture(atlas);
  tilesTex.colorSpace = THREE.SRGBColorSpace;
  tilesTex.generateMipmaps = true;
  tilesTex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tiles: tilesTex, alphaA: pack(0), alphaB: pack(4), tileMeters: man.tileMeters, means };
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

// ── T2 interiors ────────────────────────────────────────────────────────
// .dif files were converted to glb offline (io_dif → Blender 5.2 → glTF);
// the spec carries our-space pos + pre-squashed scale + the raw T2
// axis-angle. The transform composes:
//   M = T(pos) · D(scaleOurs) · SwapYZ · R(axis-angle, T2 space) · G
// G = rotX(+90°) undoes Blender's Z-up→Y-up export (glb verts are
// (u,w,-v) in T2 coords); SwapYZ maps T2 (u,v,w)→ours (u,w,v); R is the
// mission rotation in T2 axes. SwapYZ is a reflection — DoubleSide on
// every material keeps the mirrored winding renderable.
const SWAP_YZ = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1);
const G_GLB_TO_T2 = new THREE.Matrix4().makeRotationX(Math.PI / 2);

let interiorGroup: THREE.Group | null = null;
let interiorGeos: THREE.BufferGeometry[] = []; // merged geos — owned, must dispose on swap
const glbCache = new Map<string, Promise<THREE.Group | null>>();
const glbLoader = new GLTFLoader();

async function fetchGlb(httpUrl: string, file: string): Promise<THREE.Group | null> {
  const name = file.replace(/\.dif$/i, '.glb');
  let p = glbCache.get(name);
  if (!p) {
    p = glbLoader.loadAsync(`${httpUrl}/maps/t2/dif/${name}`)
      .then((g) => g.scene)
      .catch(() => null);
    glbCache.set(name, p);
  }
  return p;
}

/** Instance a converted T2 interior. Clone shares geometry/materials —
 *  these are static hulls, no skeletons. */
async function applyInteriors(ctx: NetCtx, list: InteriorSpec[] | undefined): Promise<void> {
  const { deps } = ctx;
  deps.logger.warn(`applyInteriors: list=${list === undefined ? 'undef' : list.length}`);
  const scene = deps.lazyScene();
  if (interiorGroup) {
    scene.remove(interiorGroup);
    interiorGroup = null;
    for (const g of interiorGeos) g.dispose();
    interiorGeos = [];
  }
  if (!list?.length) return;
  const { httpUrl } = await resolveServerEndpoints();
  const group = new THREE.Group();
  group.name = '__t2interiors';
  group.matrixAutoUpdate = false; // static world container
  interiorGroup = group;
  scene.add(group);

  const missing = new Set<string>();
  // Static-merge buckets: every interior sub-mesh bakes its world transform
  // into a cloned geometry and merges per (material × attribute layout) —
  // 33 hulls × dozens of primitives was hundreds of draw calls at idle.
  // Multi-material meshes keep their original mesh (rare) instead of
  // splitting groups.
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const mergedGeo: THREE.BufferGeometry[] = interiorGeos;
  const kept: THREE.Mesh[] = [];
  await Promise.all(list.map(async (spec) => {
    const src = await fetchGlb(httpUrl, spec.file);
    if (!src) { missing.add(spec.file); return; }
    const inst = src.clone(true);
    const m = new THREE.Matrix4();
    const pos = spec.pos;
    m.setPosition(pos.x, pos.y, pos.z);
    if (spec.scale) m.multiply(new THREE.Matrix4().makeScale(spec.scale.x, spec.scale.y, spec.scale.z));
    m.multiply(SWAP_YZ);
    if (spec.rot) {
      _axis.set(spec.rot[0], spec.rot[1], spec.rot[2]);
      if (_axis.lengthSq() > 1e-8) {
        _q.setFromAxisAngle(_axis.normalize(), spec.rot[3] * Math.PI / 180);
        m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(_q));
      }
    }
    m.multiply(G_GLB_TO_T2);
    inst.matrixAutoUpdate = false;
    inst.matrix.copy(m);
    inst.updateMatrixWorld(true);
    inst.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) if (mat) mat.side = THREE.DoubleSide;
      if (mats.length !== 1) {
        // Rare path: keep the multi-material mesh but pin the baked world
        // transform — re-parenting to `group` drops the instance matrix.
        const clone = mesh.clone();
        clone.matrixAutoUpdate = false;
        clone.matrix.copy(mesh.matrixWorld);
        kept.push(clone); group.add(clone); return;
      }
      const mat = mats[0]!;
      // mergeGeometries refuses mismatched attribute sets — key on the
      // layout too or one odd primitive sinks a whole material bucket.
      // Region cell goes in the key: a single map-wide bucket would get a
      // map-wide bounding sphere and never frustum-cull, so every far
      // structure rasterized every frame.
      const e = mesh.matrixWorld.elements;
      // 2048m cells: T2 GLBs shatter into ~250 materials, and the old 512m
      // grid multiplied that by 4 → ~1000 draw calls. Bigger cells keep
      // frustum culling useful at range while quartering the mesh count.
      const cell = `${e[12]! / 2048 | 0},${e[14]! / 2048 | 0}`;
      // Material dedup: the DIF exporter emits the same Blender material
      // under a new `.NNN` name per GLB (BE_EWAL01B, .001…005) — ~360
      // distinct uuids for ~60 real materials. Canonicalize on the
      // stripped name + shading params or every sibling stays its own
      // draw call.
      const canon = canonInteriorMat(mat);
      const sig = `${canon.key}|${Object.keys(mesh.geometry.attributes).toSorted().join(',')}|${mesh.geometry.index ? 'i' : 'n'}|${cell}`;
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const b = buckets.get(sig) ?? { mat: canon.mat, geos: [] };
      b.geos.push(geo);
      buckets.set(sig, b);
    });
  }));
  for (const { mat, geos } of buckets.values()) {
    const merged = mergeGeometries(geos, false);
    if (!merged) { // attribute/index quirk — fall back to the unmerged geos
      for (const g of geos) {
        const mesh = new THREE.Mesh(g, mat);
        mesh.matrixAutoUpdate = false; // baked world transform — static
        mesh.receiveShadow = true;
        mesh.userData.castR = interiorCastRadius(g);
        mesh.castShadow = mesh.userData.castR > 0;
        group.add(mesh);
        mergedGeo.push(g);
      }
      continue;
    }
    for (const g of geos) g.dispose(); // baked clones — merged owns their data now
    mergedGeo.push(merged);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.matrixAutoUpdate = false; // baked world transform — static
    mesh.receiveShadow = true;
    // Caster census: ~1000 interior meshes were all casting → ~580 extra
    // draw calls in the shadow pass. Only chunky structures' shadows read
    // at a glance — debris-scale parts don't.
    mesh.userData.castR = interiorCastRadius(merged);
    mesh.castShadow = mesh.userData.castR > 0;
    group.add(mesh);
  }
  if (missing.size) deps.logger.warn(`Interiors missing glb: ${[...missing].join(', ')}`);
  // Bake every world matrix once, then freeze the whole subtree — the
  // per-frame updateMatrixWorld walk skips it entirely instead of
  // re-multiplying hundreds of static nodes.
  group.updateMatrixWorld(true);
  group.matrixWorldAutoUpdate = false;
  deps.logger.info(`T2 interiors placed: ${list.length - missing.size}/${list.length} → ${buckets.size + kept.length} draws`);
}

const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
