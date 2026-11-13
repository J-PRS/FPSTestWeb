// World wire handlers — gameState join/restore, admin mapUpdate, and the
// server-owned creature (ball) event channel.

import * as THREE from 'three';
import { buildStructures, buildArenaDome, clearArenaDome, buildSpawnGizmos } from '../../world/mapStructures.js';
import type { SpawnPoint, StructureSpec, InteriorSpec, WeatherSpec, AtmosphereSpec, WaterSpec } from '../../../../shared/mapSpec.js';
import { setAmbientCaps } from '../species/ambientCaps.js';
import { applyStructureSpecs, clearExtraStructures } from '../structureSpecs.js';
import type { GameStatePlayer, LocalPlayerState } from '../../../../shared/protocol.js';
import type { NetworkManager } from '../../networking/NetworkManager.js';
import type { NetCtx } from './ctx.js';
import { reconcileDeployables } from './deployables.js';
import { resolveServerEndpoints } from '../../networking/endpoints.js';
import { noteLocalSnap } from '../posPrimed.js';
import type { DeployKind } from '../../../../shared/deployables.js';
import type { TeamId } from '../../../../shared/teams.js';
import { finiteVec } from '../../../../shared/wire.js';
import { saveLastRoomMap } from './lastRoom.js';
import { RIG_MANIFEST, CLASS_BODY_VARIANT } from '../../entities/playerClips.js';
import type { PlayerModelVariant } from '../../entities/PlayerModel.js';
import { mkGltfLoader, loadGltfCached } from '../../gltfLoad.js';
import { dropVolatileWorldFx } from './resync.js';
import { voidPendingEchoes } from '../parity.js';
import { applyTerrain, applyInteriors, applyMapFog, applyWeather, applyAtmosphere, applyWater, applyKillZone, firstTerrain, type MapSnapshot } from './mapAssets.js';
import type { PickupKind } from '../../../../shared/pickups.js';
import type { WorldState } from '../worldState.js';
// Boot/terrain machinery lives in mapAssets.js — re-exported so main.ts
// and lastRoom.ts keep a single import site.
export { firstTerrain, probeBootMap, bootPrimeTerrain, bootPrimedPreset } from './mapAssets.js';
export type { MapSnapshot } from './mapAssets.js';

// Session veil — an F5 boot with a stored session token waits on the
// server to either restore the old body (gameState/localPlayerState) or
// reject the token. Rendering the default spawn in that gap flashes a
// fake position/health, so we cover it until the first gameState lands.
const _reseatPos = new THREE.Vector3();

// The snapshot replaces the world — reseat every remote at its wire pos
// (or drop it when the roster doesn't name it). Locally-owned bodies are
// never on the wire and are cleaned up by their owner (TeamBots; the
// ?dummy/?dummylineup hook) — purging them here disposed a body
// mid-GLB-load and left it invisible with zero registered clips (the
// 'heavy robot T-posed/messed up' report: class_heavy is the biggest
// body, so it was the one still loading when the first snapshot landed).
// Same ownership exemption RemoteSet.prune already applies. A NaN row
// would reseat the remote into a poisoned motion state — the net.push
// finite gate doesn't cover this path.
function purgeStaleRemotes(world: WorldState, wire: ReadonlyMap<string, { x: number; y: number; z: number }>): void {
  for (const [id, rp] of world.remotePlayers) {
    if (id.startsWith('bot:') || id.startsWith('dummy')) {continue;}
    const pos = wire.get(id);
    if (!pos || !finiteVec(pos)) { world.remotePlayers.remove(id); continue; }
    _reseatPos.set(pos.x, pos.y, pos.z);
    rp.teleportTo(_reseatPos);
  }
}
let sessionVeil: HTMLDivElement | null = null;
let sessionVeilTimer: ReturnType<typeof setTimeout> | null = null;
let sessionVeilLabelTimer: ReturnType<typeof setTimeout> | null = null;
// 'ready' sender — armed alongside the veil; the server holds the body
// off-spawn until this fires (whatever the drop path: stable frames or
// the 8s force-drop timer below).
let sessionVeilDropCb: (() => void) | null = null;

export function dropSessionVeil(): void {
  try { performance.mark('load:veilDropped'); } catch { /* ignore */ }
  if (sessionVeilTimer) { clearTimeout(sessionVeilTimer); sessionVeilTimer = null; }
  if (sessionVeilLabelTimer) { clearTimeout(sessionVeilLabelTimer); sessionVeilLabelTimer = null; }
  sessionVeil?.remove();
  sessionVeil = null;
  sessionVeilReady = false;
  sessionSeated = false;
  const cb = sessionVeilDropCb;
  sessionVeilDropCb = null;
  cb?.();
}



export function armSessionVeil(label = 'RECONNECTING', onDrop?: () => void): void {
  sessionSeated = false; // a re-arm must wait for THIS session's seat
  if (onDrop) {sessionVeilDropCb = onDrop;}
  if (sessionVeil) {return;}
  const el = document.createElement('div');
  el.id = 'session-veil';
  document.body.append(el);
  sessionVeil = el;
  // A label implies a wait — only show it if the veil outlives ~1s,
  // which means the restore hit a genuinely slow path.
  sessionVeilLabelTimer = setTimeout((): void => {
    const el2 = document.createElement('span');
    el2.textContent = label; // player's frame, not the protocol's — F5 with a stored token IS a rejoin
    sessionVeil?.append(el2);
  }, 1000);
  // Connect may fail outright — never leave a black curtain up.
  sessionVeilTimer = setTimeout(dropSessionVeil, 8000);
}

// gameState landed — the loop may drop the veil once frames stabilize
// (warmup window: shaders/textures must not compile on the player's
// first interactive frame).
let sessionVeilReady = false;
export function isSessionVeilReady(): boolean { return sessionVeilReady; }

/** A wire seat landed — respawn or gameState restore wrote pos. The veil
 *  must not drop on the boot default `(0, startH+10, 0)`: origin can sit
 *  under a hill, so the first live frames would render under terrain
 *  (and stream claims that read as a kill-zone dive). */
let sessionSeated = false;
export function isSessionSeated(): boolean { return sessionSeated; }
export function markLocalSeated(): void { sessionSeated = true; }

/** While veiled there IS no session — the game loop freezes rather than
 *  simulating a boot world the incoming gameState discards anyway. */
export function isSessionVeiled(): boolean { return sessionVeil !== null; }

/** Local-player half of gameState — position/rotation/health restore on
 *  reconnect. Velocity only survives if gentle: the stored value is
 *  whatever the last packet before disconnect reported, and replaying a
 *  stale knockback vector on reload produced phantom launches. */
function restoreLocalPlayer(ctx: NetCtx, localPlayerState: LocalPlayerState): void {
  const { deps } = ctx;
  deps.logger.debug(`Restoring local player state from gameState: ${JSON.stringify(localPlayerState)}`);
  const player = deps.lazyPlayer();
  // A non-finite stored vector would poison the sim on every reconnect —
  // drop the restore rather than write NaN into the movement controller.
  const p = localPlayerState.position;
  if (!finiteVec(p)) {
    deps.logger.warn(`Local-player restore dropped: non-finite position ${JSON.stringify(p)}`);
    return;
  }
  player.protectedUntil = performance.now() + (localPlayerState.protectedMs ?? 0);

  const v = localPlayerState.velocity;
  const anchorVel = v && Math.hypot(v.x, v.y, v.z) < 10 ? v : { x: 0, y: 0, z: 0 };
  restoreBodyPosition(ctx, player, localPlayerState, p, anchorVel);
  noteLocalSnap();
  deps.setLastSentPos({ x: p.x, y: p.y, z: p.z });
  applyRestoredVitals(ctx, player, localPlayerState);

  deps.logger.debug(`Player state restored from gameState - pos(${localPlayerState.position.x.toFixed(1)},${localPlayerState.position.y.toFixed(1)},${localPlayerState.position.z.toFixed(1)}) vel(${localPlayerState.velocity?.x.toFixed(1) || 0},${localPlayerState.velocity?.y.toFixed(1) || 0},${localPlayerState.velocity?.z.toFixed(1) || 0}) health:${localPlayerState.health} dead:${localPlayerState.isDead}`);
}

type LocalPlayer = ReturnType<NetCtx['deps']['lazyPlayer']>;

// Body restore: journal replay when the shadow's anchor is stale (same
// machinery a correction runs - rewind to last-accepted pos, replay the
// inputs the server never consumed), else the plain snap. A fresh
// join's journal is empty - same-input-seq or a dead body takes the snap.
function restoreBodyPosition(ctx: NetCtx, player: LocalPlayer, localPlayerState: LocalPlayerState, p: { x: number; y: number; z: number }, anchorVel: { x: number; y: number; z: number }): void {
  const { deps, nm } = ctx;
  const journal = !localPlayerState.isDead && localPlayerState.inputSeq !== undefined
    ? nm().inputsAfter(localPlayerState.inputSeq, nm().getPing()) : [];
  if (journal.length === 0) {
    player.pos.set(p.x, p.y, p.z);
    if (Number.isFinite(localPlayerState.rotation.yaw + localPlayerState.rotation.pitch)) {
      player.yaw = localPlayerState.rotation.yaw;
      player.pitch = localPlayerState.rotation.pitch;
    }
    player.vel.set(anchorVel.x, anchorVel.y, anchorVel.z);
    return;
  }
  player.movement.setState({
    pos: new THREE.Vector3(p.x, p.y, p.z),
    vel: new THREE.Vector3(anchorVel.x, anchorVel.y, anchorVel.z),
    yaw: player.yaw, pitch: player.pitch,
    // localPlayerState doesn't carry grounded — seeded true, but only
    // the first replayed update() consults it before raycasting real
    // contact, so a mid-air restore costs at most one step of friction.
    onGround: true,
  });
  const now = performance.now();
  for (let i = 0; i < journal.length; i += 1) {
    const e = journal[i];
    const nextT = i + 1 < journal.length ? journal[i + 1]!.t : now;
    player.movement.setInput({
      forward: e.input.forward, right: e.input.right,
      jumpPressed: Boolean(e.input.jump), jumpHeld: Boolean(e.input.jump),
      skiHeld: Boolean(e.input.ski), jetHeld: Boolean(e.input.jet),
    });
    player.movement.update(Math.min(0.25, Math.max(0, (nextT - e.t) / 1000)));
  }
  const st = player.movement.getState();
  player.pos.set(st.pos.x, st.pos.y, st.pos.z);
  player.vel.set(st.vel.x, st.vel.y, st.vel.z);
  player.onGround = st.onGround;
  deps.logger.info(`Reconnect restore replayed: ${journal.length} inputs from seq ${localPlayerState.inputSeq}`);
}

// Vitals + seat bookkeeping after the body lands: tokens/health/armor/
// dead flag, controller reseat, declared-discontinuity teleport mark,
// death overlay, seated mark, and the veil-less spawn-hold release.
function applyRestoredVitals(ctx: NetCtx, player: LocalPlayer, localPlayerState: LocalPlayerState): void {
  const { deps, nm } = ctx;
  player.heldTokens = localPlayerState.held ?? 0;
  // Bloom draw counter is server-truth: a reclaim carries it forward, a
  // demote reset it - adopting the stamped count keeps the predicted
  // cone seed locked to the authority's stream either way.
  if (localPlayerState.bloomSeq !== undefined) {player.bloomSeq = localPlayerState.bloomSeq; player.bloom = 0;}
  if (Number.isFinite(localPlayerState.health)) {player.health = localPlayerState.health;}
  player.armor = Number.isFinite(localPlayerState.armor) ? localPlayerState.armor! : 0;
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
  markLocalSeated();
  // A veil-less seat (menu-join / room-switch mid-session) has no drop
  // to fire it — release the spawn-hold now; the server no-ops 'ready'
  // on a seat that isn't held. Veiled seats release via the drop cb.
  if (!isSessionVeiled()) {nm().sendReady();}
}



/** Room snapshot half of gameState — mode, team, scores, clock, map
 *  geometry, mid-flight pickups/flags. Pure world setup, no local player. */
function applyRoomInfo(ctx: NetCtx, playerCount: number, roomInfo?: Parameters<NonNullable<NetworkManager['onGameState']>>[2]): void {
  const { deps, networkManager } = ctx;
  if (!roomInfo) {return;}
  deps.world.mode = roomInfo.mode;
  deps.world.instagib = roomInfo.instagib === true;
  deps.world.gungame = roomInfo.gungame === true;
  deps.world.igun = roomInfo.igun === true;
  // The modifier owns the kit while it lasts - apply/release are
  // idempotent so every gameState (reconnects, resyncs) re-asserts it.
  const {armory} = deps.lazyPlayer();
  if (deps.world.instagib) {armory.applyInstagib();} else {armory.releaseInstagib();}
  if (deps.world.gungame) {armory.applyGunGame(deps.world.igun === true);} else {armory.releaseGunGame();}
  if (roomInfo.mapName) {deps.world.mapName = roomInfo.mapName;}
  if (roomInfo.room !== undefined) {deps.retireOfflineBots?.();}
  applyMatchMeta(ctx, roomInfo);
  if (Number.isFinite(roomInfo.respawnMs) && roomInfo.respawnMs! > 0) {deps.world.respawnMs = roomInfo.respawnMs!;}
  announceRoom(ctx, playerCount, roomInfo);
  // Pickups still lying on the field when we (re)joined — the roster is
  // authoritative both ways: spawn what's there, drop ghosts whose
  // pickupGone we missed while disconnected.
  ctx.reconcilePickups(new Set((roomInfo.pickups ?? []).map((p): number => p.id)));
  for (const p of roomInfo.pickups ?? []) {ctx.addPickup(p.id, p.pos, p.kind ?? 'gem', p.val ?? 1);}
  reconcileDeployables(ctx, roomInfo.deployables);
  applyMapSnapshot(ctx, roomInfo.map);
  // Remember this room's map — F5 boots straight into it while the
  // socket round-trips instead of flashing the default field.
  resolveServerEndpoints().then(({ httpUrl }): void => saveLastRoomMap(httpUrl, roomInfo.map))
    .catch((error): void => ctx.deps.logger.warn(`saveLastRoomMap failed: ${error instanceof Error ? error.message : String(error)}`));
  // Flags mid-flight when we joined — same path as a flagUpdate broadcast.
  // An empty/absent list on a room hop must also clear the old room's
  // banners and HUD chips, so fire it either way.
  networkManager.onFlagUpdate?.(roomInfo.flags ?? []);
}



export function wireWorld(ctx: NetCtx): void {
  const { deps, networkManager, chat } = ctx;
  const {logger} = deps;

  // Server-owned creatures — events only; the client replays the shared
  // sim between segments.
  networkManager.onBallSpawn = (data): void => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netBallSpawn(data);
  };
  networkManager.onBallSegment = (data): void => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netBallSegment(data);
  };
  networkManager.onBallDie = (data): void => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netBallDie(data);
  };
  networkManager.onBallRoster = (data): void => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netBallRoster(data);
  };

  // Server-owned melee species — crawl* events drive netDriven Crawler
  // instances replaying shared/creatureSim.ts (see game/netCrawlers.ts).
  networkManager.onCrawlSpawn = (data): void => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netCrawlSpawn(data);
  };
  networkManager.onCrawlEvt = (data): void => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netCrawlEvt(data);
  };
  networkManager.onCrawlDie = (data): void => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netCrawlDie(data);
  };
  networkManager.onCrawlRoster = (data): void => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netCrawlRoster(data);
  };

  // Admin hot-reload — the room's map spec changed mid-match. Rebuild the
  // static geometry exactly like the join path does from gameState.
  networkManager.onMapUpdate = (map): void => {
    if (map.mapName) {deps.world.mapName = map.mapName;}
    buildStructures(map.structures ?? [], deps.lazyScene(), deps.lazyTerrain());
    // Mode-minted solids die with the world rebuild — a live mode
    // bridge re-feeds them on its next lattice sync.
    clearExtraStructures();
    applyStructureSpecs(map.structures, deps.lazyPlayer().movement);
    if (map.arena) {
      buildArenaDome(map.arena, deps.lazyTerrain().getHeight(map.arena.x, map.arena.z), deps.lazyScene());
    } else {
      clearArenaDome(deps.lazyScene());
    }
    deps.world.spawnPools = map.spawns || map.teamSpawns ? { spawns: map.spawns, teamSpawns: map.teamSpawns } : null;
    installSpawnGizmos(ctx);
    if (map.terrain || map.heightScale || map.tileSize) {
      applyTerrain(ctx, { file: map.terrain ?? null, texPath: map.terrainTex, skyDir: map.sky, heightScale: map.heightScale, tileSize: map.tileSize, terrainPreset: map.terrainPreset })
        .catch((error): void => ctx.deps.logger.warn(`applyTerrain failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    applyMapFog(ctx, map.fog);
    applyWeather(ctx, map.weather);
    applyAtmosphere(ctx, map.atmosphere);
    deps.world.lastAtmo = { fog: map.fog, weather: map.weather, atmosphere: map.atmosphere, terrain: map.terrain, terrainTex: map.terrainTex, terrainPreset: map.terrainPreset, heightScale: map.heightScale, tileSize: map.tileSize, sky: map.sky };
    ctx.deps.lazyDemoManager?.()?.recordAtmo(deps.world.lastAtmo);
    applyWater(ctx, map.water);
    applyKillZone(ctx, map.killY);
    applyInteriors(ctx, map.interiors)
      .catch((error): void => ctx.deps.logger.warn(`applyInteriors failed: ${error instanceof Error ? error.message : String(error)}`));
    resolveServerEndpoints().then(({ httpUrl }): void => saveLastRoomMap(httpUrl, map))
      .catch((error): void => ctx.deps.logger.warn(`saveLastRoomMap failed: ${error instanceof Error ? error.message : String(error)}`));
    if (!map.silent) {chat.add(null, 'map updated by admin');}
  };

  // Initial connection and reconnection — full roster + local restore.
  networkManager.onGameState = (players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; instagib?: boolean; gungame?: boolean; igun?: boolean; mapName?: string; team?: TeamId; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; pickups?: { id: number; pos: { x: number; y: number; z: number }; kind?: PickupKind; val?: number }[]; flags?: { team: TeamId; pos: { x: number; y: number; z: number }; home?: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; matchEndsAt?: number; respawnMs?: number; deployables?: { id: number; owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; team?: string }[]; map?: { mode?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; killY?: number; ambient?: Record<string, number>; terrain?: string; heightScale?: number; tileSize?: number; fog?: { color: [number, number, number]; distance?: number; visible?: number; horizon?: [number, number, number] }; water?: WaterSpec; spawns?: SpawnPoint[]; teamSpawns?: { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] }; terrainTex?: string; terrainPreset?: number; sky?: string; weather?: WeatherSpec; atmosphere?: AtmosphereSpec; interiors?: InteriorSpec[] } }): void => {
    logger.info(`gameState room=${roomInfo?.room} mapKeys=${roomInfo?.map ? Object.keys(roomInfo.map).join(',') : 'none'}`);
    // The snapshot replaces the world — any volatile layer still alive
    // pre-reconnect is stale fast-forward, not truth. Purge before
    // re-seeding (the hidden-tab regain path can't cover a socket that
    // died and rejoined while we were still looking at the screen).
    dropVolatileWorldFx(deps.world);
    // Parity verdicts pending on the dead socket can never confirm - their
    // playerHit/knockback wires died with it. Void them (and the kb stamps'
    // consume queue) or every pre-drop prediction expires as a false miss.
    voidPendingEchoes();
    deps.world.selfBlastStamps.length = 0;
    // A gameState is a full world snapshot — every remote snapshot buffered
    // before it is stale. Worse, serverMs is per-room (tickSeq×50): a room
    // hop/restart rewinds it, and pushes stamped behind the buffer's anchor
    // get pruned as stale — the remote freezes at its old-room coords while
    // the wire keeps updating (the 500m renderΔ rubber-band). Reseat every
    // remote: wire pos where the roster has one, own position otherwise —
    // either way the buffer clears and the next push re-anchors.
    const wire = new Map(players.map(p => [p.id, p.position]));
    purgeStaleRemotes(deps.world, wire);
    applyRoomInfo(ctx, players.length, roomInfo);
    if (localPlayerState) {restoreLocalPlayer(ctx, localPlayerState);}
    // Warm every class-body rig parse — remote ctors fire on paced spawn
    // admits, so the last variant's ~460ms worker parse otherwise starts
    // ~5s into the veil (the 10s rig tail). The class set is closed
    // (scout/brawler/brute + vexa fallback); warming all four in the
    // worker costs nothing on main and the cache is per-URL session-wide.
    {
      const urls = new Set<string>();
      for (const v of Object.values(CLASS_BODY_VARIANT)) {
        const u = RIG_MANIFEST[v as PlayerModelVariant]?.url;
        if (u) {urls.add(u);}
      }
      const def = RIG_MANIFEST['vexa' as PlayerModelVariant]?.url; // unknown-class fallback
      if (def) {urls.add(def);}
      const loader = mkGltfLoader();
      for (const u of urls) {void loadGltfCached(loader, u).catch((): void => undefined);}
    }
    // Real state landed — the loop drops the veil once frames stabilize
    // (warmup window; the 8s timer remains the connect-fail escape).
    // The seat sits on the ROOM's field, not the boot heightmap — until
    // the terrain swap completes the local sim would fall toward
    // boot-ground and eat a 40m+ correction snap. The veil holds through
    // the swap so the first simulated frame runs on the right field.
    void firstTerrain.then((): void => { sessionVeilReady = true; });
    // The 8s connect-fail escape only guards the wait for gameState; once
    // it lands the veil holds until the local player actually spawns.
    if (sessionVeilTimer) { clearTimeout(sessionVeilTimer); sessionVeilTimer = null; }
  };
}

/** Structures, dome, and per-map species caps — shared by gameState's
 *  join path; mapUpdate handles the same rebuild itself since it always
 *  knows a spec exists. Clears rather than skips on absence: a room hop
 *  re-runs gameState, and the old room's geometry must not survive. */
/** (Re)build the F1 spawn-sphere domes from the stored pools. The
 *  heightfield swap resolves async, so domes built against the boot
 *  field re-seat when the real terrain lands — the chain on
 *  onTerrainApplied (bot reseat already owns the slot) arms once and
 *  re-reads the live pools, so reconnects don't stack wrappers. */
let spawnGizmoHookArmed = false;
function installSpawnGizmos(ctx: NetCtx): void {
  const { deps } = ctx;
  const groundAt = (x: number, z: number): number => deps.lazyTerrain().getHeight(x, z);
  buildSpawnGizmos(deps.world.spawnPools, deps.lazyScene(), groundAt);
  if (spawnGizmoHookArmed) {return;}
  spawnGizmoHookArmed = true;
  const prev = deps.world.onTerrainApplied;
  deps.world.onTerrainApplied = (file): void => {
    prev?.(file);
    // Bots re-seat via teamBots.reseatAll — the LOCAL player needs the
    // same mercy: a joiner seats against the boot heightmap, and if the
    // room's real field is higher their sim falls to boot-ground before
    // the first report (the 47m join snap + teleport-above-ground
    // invariants the server then counts). Lift to the new floor — the
    // server's seat correction owns the fine position either way.
    const p = deps.lazyPlayer();
    const g = groundAt(p.pos.x, p.pos.z);
    if (Number.isFinite(g) && p.pos.y < g - 0.5) {
      p.pos.y = g + 0.5;
      if (p.vel.y < 0) {p.vel.y = 0;} // the boot-field fall's momentum dies here
    }
    buildSpawnGizmos(deps.world.spawnPools, deps.lazyScene(), groundAt);
  };
}

function applyMapSnapshot(ctx: NetCtx, map?: MapSnapshot): void {
  applyMapStructures(ctx, map);
  applyMapAtmo(ctx, map);
  applyMapTail(ctx, map);
}

// Structures + spawn pools + arena dome. clearExtraStructures runs
// before the spec pass: a map swap must not keep the old world's mode
// solids. The collider list is the same one the server sims against -
// ball prediction ricochets off structures identically, and player
// collision divergence reads as walls that let you through.
function applyMapStructures(ctx: NetCtx, map?: MapSnapshot): void {
  const { deps } = ctx;
  buildStructures(map?.structures ?? [], deps.lazyScene(), deps.lazyTerrain());
  clearExtraStructures();
  applyStructureSpecs(map?.structures, deps.lazyPlayer().movement);
  // Spawn pools ride the map snapshot — debug command-map layer only.
  // Clears on absence: a room hop must not keep the old map's spheres.
  deps.world.spawnPools = map?.spawns || map?.teamSpawns ? { spawns: map.spawns, teamSpawns: map.teamSpawns } : null;
  installSpawnGizmos(ctx);
  if (map?.arena) {
    buildArenaDome(map.arena, deps.lazyTerrain().getHeight(map.arena.x, map.arena.z), deps.lazyScene());
  } else {
    clearArenaDome(deps.lazyScene());
  }
}

function applyMapAtmo(ctx: NetCtx, map?: MapSnapshot): void {
  const { deps } = ctx;
  setAmbientCaps(map?.ambient);
  applyMapFog(ctx, map?.fog);
  applyWeather(ctx, map?.weather);
  applyAtmosphere(ctx, map?.atmosphere);
  deps.world.lastAtmo = atmoRecord(map);
  ctx.deps.lazyDemoManager?.()?.recordAtmo(deps.world.lastAtmo);
}

// The atmo slice demos record for playback restore - every field the
// apply* calls above consume, in one literal.
function atmoRecord(map?: MapSnapshot): NonNullable<NetCtx['deps']['world']['lastAtmo']> {
  return { fog: map?.fog, weather: map?.weather, atmosphere: map?.atmosphere, terrain: map?.terrain, terrainTex: map?.terrainTex, terrainPreset: map?.terrainPreset, heightScale: map?.heightScale, tileSize: map?.tileSize, sky: map?.sky };
}

// Async asset tail - each loader reports its own failure so one bad
// fetch can't mask the others.
function applyMapTail(ctx: NetCtx, map?: MapSnapshot): void {
  applyWater(ctx, map?.water);
  applyKillZone(ctx, map?.killY);
  applyTerrain(ctx, { file: map?.terrain ?? null, texPath: map?.terrainTex, skyDir: map?.sky, heightScale: map?.heightScale, tileSize: map?.tileSize, terrainPreset: map?.terrainPreset })
    .catch((error): void => ctx.deps.logger.warn(`applyTerrain failed: ${error instanceof Error ? error.message : String(error)}`));
  applyInteriors(ctx, map?.interiors)
    .catch((error): void => ctx.deps.logger.warn(`applyInteriors failed: ${error instanceof Error ? error.message : String(error)}`));
}



/** Chat lines summarizing what we just joined — clock, room, team, board. */
function announceRoom(ctx: NetCtx, playerCount: number, roomInfo?: RoomInfo): void {
  const { chat } = ctx;
  if (roomInfo?.matchEndsAt) {
    const leftMin = Math.max(0, Math.ceil((roomInfo.matchEndsAt - Date.now()) / 60_000));
    chat.add(null, `match clock — ~${leftMin}m left${leftMin === 0 ? ' (overtime)' : ''}`);
  }
  if (roomInfo?.room && roomInfo.room !== 'default') {
    chat.add(null, `joined room '${roomInfo.room}'${roomInfo.mode ? ` (${roomInfo.mode})` : ''} — ${playerCount} other player(s)`);
  }
  if (roomInfo?.team) {
    chat.add(null, `you are on ${roomInfo.team.toUpperCase()}${roomInfo.scores ? ` — ALPHA ${roomInfo.scores.alpha} : BRAVO ${roomInfo.scores.bravo}` : ''}`);
  }
  if (roomInfo?.ffaScores && Object.keys(roomInfo.ffaScores).length > 0) {
    const top = Object.entries(roomInfo.ffaScores).toSorted((a, b): number => b[1] - a[1]).slice(0, 3);
    chat.add(null, `dm board — ${top.map(([id, s]): string => `${id} ${s}`).join(' / ')}`);
  }
}



/** Match meta (team/scores/clock/board) — a room-scoped gameState is
 *  authoritative, so a hop that drops them clears rather than leaves the
 *  old match's residue. The `room` gate keeps offline modes (TeamBots
 *  localTeam) untouched: only the server sends a room name. */
function applyMatchMeta(ctx: NetCtx, roomInfo: RoomInfo): void {
  const scores = roomInfo?.scores && Number.isFinite(roomInfo.scores.alpha + roomInfo.scores.bravo)
    ? roomInfo.scores : undefined;
  const ffaScores = roomInfo?.ffaScores && !Object.values(roomInfo.ffaScores).some((v): boolean => !Number.isFinite(v))
    ? roomInfo.ffaScores : undefined;
  const matchEndsAt = Number.isFinite(roomInfo?.matchEndsAt) ? roomInfo!.matchEndsAt : undefined;
  if (roomInfo?.room !== undefined) {
    applyRoomMeta(ctx.deps, roomInfo, scores, ffaScores, matchEndsAt);
    return;
  }
  applyPartialMeta(ctx, roomInfo, scores, ffaScores, matchEndsAt);
}

// Room-scoped gameState is authoritative - a hop that drops team/scores/
// clock/board clears them rather than leaving the old match's residue.
function applyRoomMeta(deps: NetCtx['deps'], roomInfo: RoomInfo, scores: { alpha: number; bravo: number } | undefined, ffaScores: Record<string, number> | undefined, matchEndsAt: number | undefined): void {
  deps.world.localTeam = roomInfo?.team;
  deps.world.teamScores = scores ?? null;
  deps.world.ffaScores = new Map(Object.entries(ffaScores ?? {}));
  deps.world.matchEndsAt = matchEndsAt ?? null;
}

// Offline/partial updates (no room name): each present field applies
// independently - absence means "not provided", not "clear". The
// recordMatchMeta edge only fires when scores or clock actually moved.
function applyPartialMeta(ctx: NetCtx, roomInfo: RoomInfo, scores: { alpha: number; bravo: number } | undefined, ffaScores: Record<string, number> | undefined, matchEndsAt: number | undefined): void {
  const { deps } = ctx;
  if (roomInfo?.team !== undefined) {deps.world.localTeam = roomInfo.team;}
  if (scores) {deps.world.teamScores = scores;}
  if (matchEndsAt !== undefined) {deps.world.matchEndsAt = matchEndsAt;}
  if (ffaScores) {deps.world.ffaScores = new Map(Object.entries(ffaScores));}
  if (scores || matchEndsAt !== undefined) {
    const s = deps.world.teamScores;
    deps.lazyDemoManager?.()?.recordMatchMeta(s?.alpha ?? 0, s?.bravo ?? 0, matchEndsAt === undefined ? 0 : matchEndsAt - Date.now());
  }
}



type RoomInfo = Parameters<NonNullable<NetworkManager['onGameState']>>[2];

/** Apply the probed saved map once the net ctx exists — structures,
 *  arena, interiors, albedo, sky. gameState that follows re-applies the
 *  same map for free or corrects it outright. */
export function bootApplySavedMap(ctx: NetCtx, map: MapSnapshot | null): void {
  if (map) {applyMapSnapshot(ctx, map);}
}
