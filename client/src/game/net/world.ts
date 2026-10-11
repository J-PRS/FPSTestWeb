// World wire handlers — gameState join/restore, admin mapUpdate, and the
// server-owned creature (ball) event channel.

import * as THREE from 'three';
import { buildStructures, buildArenaDome, clearArenaDome } from '../../world/mapStructures.js';
import type { StructureSpec, InteriorSpec } from '../../../../shared/mapSpec.js';
import { setAmbientCaps } from '../species/ambientCaps.js';
import { applyStructureSpecs } from '../structureSpecs.js';
import type { GameStatePlayer, LocalPlayerState } from '../../../../shared/protocol.js';
import type { NetworkManager } from '../../networking/NetworkManager.js';
import type { NetCtx } from './ctx.js';
import { reconcileDeployables } from './deployables.js';
import { resolveServerEndpoints } from '../../networking/endpoints.js';
import { noteLocalSnap } from '../gameLoop.js';
import type { DeployKind } from '../../../../shared/deployables.js';
import type { TeamId } from '../../../../shared/teams.js';
import { finiteVec } from '../../../../shared/wire.js';
import { saveLastRoomMap } from './lastRoom.js';
import { dropVolatileWorldFx } from './resync.js';
import { applyTerrain, applyInteriors, applyMapFog, type MapSnapshot } from './mapAssets.js';
// Boot/terrain machinery lives in mapAssets.js — re-exported so main.ts
// and lastRoom.ts keep a single import site.
export { firstTerrain, probeBootMap, bootPrimeTerrain } from './mapAssets.js';
export type { MapSnapshot } from './mapAssets.js';

// Session veil — an F5 boot with a stored session token waits on the
// server to either restore the old body (gameState/localPlayerState) or
// reject the token. Rendering the default spawn in that gap flashes a
// fake position/health, so we cover it until the first gameState lands.
const _reseatPos = new THREE.Vector3();
let sessionVeil: HTMLDivElement | null = null;
let sessionVeilTimer: ReturnType<typeof setTimeout> | null = null;
let sessionVeilLabelTimer: ReturnType<typeof setTimeout> | null = null;

export function armSessionVeil(): void {
  if (sessionVeil) {return;}
  const el = document.createElement('div');
  el.id = 'session-veil';
  document.body.append(el);
  sessionVeil = el;
  // A label implies a wait — only show it if the veil outlives ~1s,
  // which means the restore hit a genuinely slow path.
  sessionVeilLabelTimer = setTimeout(() => {
    const label = document.createElement('span');
    label.textContent = 'RECONNECTING'; // player's frame, not the protocol's — F5 with a stored token IS a rejoin
    sessionVeil?.append(label);
  }, 1000);
  // Connect may fail outright — never leave a black curtain up.
  sessionVeilTimer = setTimeout(dropSessionVeil, 8000);
}

export function dropSessionVeil(): void {
  if (sessionVeilTimer) { clearTimeout(sessionVeilTimer); sessionVeilTimer = null; }
  if (sessionVeilLabelTimer) { clearTimeout(sessionVeilLabelTimer); sessionVeilLabelTimer = null; }
  sessionVeil?.remove();
  sessionVeil = null;
}

/** While veiled there IS no session — the game loop freezes rather than
 *  simulating a boot world the incoming gameState discards anyway. */
export function isSessionVeiled(): boolean { return sessionVeil !== null; }

export function wireWorld(ctx: NetCtx): void {
  const { deps, networkManager, chat } = ctx;
  const {logger} = deps;

  // Server-owned creatures — events only; the client replays the shared
  // sim between segments.
  networkManager.onBallSpawn = (data) => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netBallSpawn(data);
  };
  networkManager.onBallSegment = (data) => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netBallSegment(data);
  };
  networkManager.onBallDie = (data) => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netBallDie(data);
  };
  networkManager.onBallRoster = (data) => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netBallRoster(data);
  };

  // Server-owned melee species — crawl* events drive netDriven Crawler
  // instances replaying shared/creatureSim.ts (see game/netCrawlers.ts).
  networkManager.onCrawlSpawn = (data) => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netCrawlSpawn(data);
  };
  networkManager.onCrawlEvt = (data) => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netCrawlEvt(data);
  };
  networkManager.onCrawlDie = (data) => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netCrawlDie(data);
  };
  networkManager.onCrawlRoster = (data) => {
    if (deps.world.playbackMode) {return;}
    deps.entities().netCrawlRoster(data);
  };

  // Admin hot-reload — the room's map spec changed mid-match. Rebuild the
  // static geometry exactly like the join path does from gameState.
  networkManager.onMapUpdate = (map) => {
    if (map.mapName) {deps.world.mapName = map.mapName;}
    buildStructures(map.structures ?? [], deps.lazyScene(), deps.lazyTerrain());
    applyStructureSpecs(map.structures, deps.lazyPlayer().movement);
    if (map.arena) {
      buildArenaDome(map.arena, deps.lazyTerrain().getHeight(map.arena.x, map.arena.z), deps.lazyScene());
    } else {
      clearArenaDome(deps.lazyScene());
    }
    if (map.terrain || map.heightScale || map.tileSize) {
      applyTerrain(ctx, map.terrain ?? null, map.terrainTex, map.sky, map.heightScale, map.tileSize, map.terrainPreset)
        .catch((error) => ctx.deps.logger.warn(`applyTerrain failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    applyMapFog(ctx, map.fog);
    applyInteriors(ctx, map.interiors)
      .catch((error) => ctx.deps.logger.warn(`applyInteriors failed: ${error instanceof Error ? error.message : String(error)}`));
    resolveServerEndpoints().then(({ httpUrl }) => saveLastRoomMap(httpUrl, map))
      .catch((error) => ctx.deps.logger.warn(`saveLastRoomMap failed: ${error instanceof Error ? error.message : String(error)}`));
    if (!map.silent) {chat.add(null, 'map updated by admin');}
  };

  // Initial connection and reconnection — full roster + local restore.
  networkManager.onGameState = (players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; mapName?: string; team?: TeamId; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; pickups?: { id: number; pos: { x: number; y: number; z: number }; kind?: import('../../../../shared/pickups.js').PickupKind }[]; flags?: { team: TeamId; pos: { x: number; y: number; z: number }; home?: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; matchEndsAt?: number; respawnMs?: number; deployables?: { id: number; owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; team?: string }[]; map?: { mode?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string; heightScale?: number; tileSize?: number; fog?: { color: [number, number, number]; distance?: number; visible?: number; horizon?: [number, number, number] }; terrainTex?: string; terrainPreset?: number; sky?: string; interiors?: InteriorSpec[] } }) => {
    logger.info(`gameState room=${roomInfo?.room} mapKeys=${roomInfo?.map ? Object.keys(roomInfo.map).join(',') : 'none'}`);
    // The snapshot replaces the world — any volatile layer still alive
    // pre-reconnect is stale fast-forward, not truth. Purge before
    // re-seeding (the hidden-tab regain path can't cover a socket that
    // died and rejoined while we were still looking at the screen).
    dropVolatileWorldFx(deps.world);
    // A gameState is a full world snapshot — every remote snapshot buffered
    // before it is stale. Worse, serverMs is per-room (tickSeq×50): a room
    // hop/restart rewinds it, and pushes stamped behind the buffer's anchor
    // get pruned as stale — the remote freezes at its old-room coords while
    // the wire keeps updating (the 500m renderΔ rubber-band). Reseat every
    // remote: wire pos where the roster has one, own position otherwise —
    // either way the buffer clears and the next push re-anchors.
    const wire = new Map(players.map(p => [p.id, p.position]));
    for (const [id, rp] of deps.world.remotePlayers) {
      const pos = wire.get(id);
      // A room hop's roster replaces wholesale — an entity the snapshot
      // doesn't name is from the old room: keeping it leaves a ghost body
      // that renders and collides-feels real but can never update.
      if (!pos) { deps.world.remotePlayers.remove(id); continue; }
      // Roster pos bypasses the net.push finite gate — a NaN row would
      // reseat the remote into a poisoned motion state.
      if (!finiteVec(pos)) { deps.world.remotePlayers.remove(id); continue; }
      _reseatPos.set(pos.x, pos.y, pos.z);
      rp.teleportTo(_reseatPos);
    }
    applyRoomInfo(ctx, players.length, roomInfo);
    if (localPlayerState) {restoreLocalPlayer(ctx, localPlayerState);}
    dropSessionVeil(); // state is real now — default spawn never painted
  };
}

/** Room snapshot half of gameState — mode, team, scores, clock, map
 *  geometry, mid-flight pickups/flags. Pure world setup, no local player. */
function applyRoomInfo(ctx: NetCtx, playerCount: number, roomInfo?: Parameters<NonNullable<NetworkManager['onGameState']>>[2]): void {
  const { deps, networkManager } = ctx;
  if (!roomInfo) {return;}
  deps.world.mode = roomInfo.mode;
  if (roomInfo.mapName) {deps.world.mapName = roomInfo.mapName;}
  if (roomInfo.room !== undefined) {deps.retireOfflineBots?.();}
  applyMatchMeta(ctx, roomInfo);
  if (roomInfo.respawnMs) {deps.world.respawnMs = roomInfo.respawnMs;}
  announceRoom(ctx, playerCount, roomInfo);
  // Pickups still lying on the field when we (re)joined — the roster is
  // authoritative both ways: spawn what's there, drop ghosts whose
  // pickupGone we missed while disconnected.
  ctx.reconcilePickups(new Set((roomInfo.pickups ?? []).map(p => p.id)));
  for (const p of roomInfo.pickups ?? []) {ctx.addPickup(p.id, p.pos, p.kind ?? 'gem');}
  reconcileDeployables(ctx, roomInfo.deployables);
  applyMapSnapshot(ctx, roomInfo.map);
  // Remember this room's map — F5 boots straight into it while the
  // socket round-trips instead of flashing the default field.
  resolveServerEndpoints().then(({ httpUrl }) => saveLastRoomMap(httpUrl, roomInfo.map))
    .catch((error) => ctx.deps.logger.warn(`saveLastRoomMap failed: ${error instanceof Error ? error.message : String(error)}`));
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
  if (roomInfo?.team !== undefined) {deps.world.localTeam = roomInfo.team;}
  if (roomInfo?.scores) {deps.world.teamScores = roomInfo.scores;}
  if (roomInfo?.matchEndsAt) {deps.world.matchEndsAt = roomInfo.matchEndsAt;}
  if (roomInfo?.ffaScores) {deps.world.ffaScores = new Map(Object.entries(roomInfo.ffaScores));}
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
  buildStructures(map?.structures ?? [], deps.lazyScene(), deps.lazyTerrain());
  // Same collider list the server sims against — ball prediction
  // ricochets off structures identically instead of phasing through.
  // Player collision comes from the same table — a divergence there
  // reads as walls that let you through.
  applyStructureSpecs(map?.structures, deps.lazyPlayer().movement);
  if (map?.arena) {
    buildArenaDome(map.arena, deps.lazyTerrain().getHeight(map.arena.x, map.arena.z), deps.lazyScene());
  } else {
    clearArenaDome(deps.lazyScene());
  }
  setAmbientCaps(map?.ambient);
  applyMapFog(ctx, map?.fog);
  applyTerrain(ctx, map?.terrain ?? null, map?.terrainTex, map?.sky, map?.heightScale, map?.tileSize, map?.terrainPreset)
    .catch((error) => ctx.deps.logger.warn(`applyTerrain failed: ${error instanceof Error ? error.message : String(error)}`));
  applyInteriors(ctx, map?.interiors)
    .catch((error) => ctx.deps.logger.warn(`applyInteriors failed: ${error instanceof Error ? error.message : String(error)}`));
}

/** Local-player half of gameState — position/rotation/health restore on
 *  reconnect. Velocity only survives if gentle: the stored value is
 *  whatever the last packet before disconnect reported, and replaying a
 *  stale knockback vector on reload produced phantom launches. */
function restoreLocalPlayer(ctx: NetCtx, localPlayerState: LocalPlayerState): void {
  const { deps, nm } = ctx;
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

  // The anchor is the shadow's last-accepted position — on a lossy link
  // that's seconds stale. Rewind to it and replay the journaled inputs
  // the server never consumed (same machinery a correction runs), so a
  // WT flap converges to where you actually are instead of yanking the
  // body back to where the wire last saw it. A fresh join's journal is
  // empty — same-input-seq or a dead body restores take the plain snap.
  const journal = !localPlayerState.isDead && localPlayerState.inputSeq !== undefined
    ? nm().inputsAfter(localPlayerState.inputSeq, nm().getPing()) : [];
  if (journal.length) {
    player.movement.setState({
      pos: new THREE.Vector3(p.x, p.y, p.z),
      vel: new THREE.Vector3(anchorVel.x, anchorVel.y, anchorVel.z),
      yaw: player.yaw, pitch: player.pitch,
      onGround: true,
    });
    const now = performance.now();
    for (let i = 0; i < journal.length; i++) {
      const e = journal[i];
      const nextT = i + 1 < journal.length ? journal[i + 1]!.t : now;
      player.movement.setInput({
        forward: e.input.forward, right: e.input.right,
        jumpPressed: !!e.input.jump, jumpHeld: !!e.input.jump,
        skiHeld: !!e.input.ski, jetHeld: !!e.input.jet,
      });
      player.movement.update(Math.min(0.25, Math.max(0, (nextT - e.t) / 1000)));
    }
    const st = player.movement.getState();
    player.pos.set(st.pos.x, st.pos.y, st.pos.z);
    player.vel.set(st.vel.x, st.vel.y, st.vel.z);
    player.onGround = st.onGround;
    deps.logger.info(`Reconnect restore replayed: ${journal.length} inputs from seq ${localPlayerState.inputSeq}`);
  } else {
    player.pos.set(p.x, p.y, p.z);
    player.yaw = localPlayerState.rotation.yaw;
    player.pitch = localPlayerState.rotation.pitch;
    player.vel.set(anchorVel.x, anchorVel.y, anchorVel.z);
  }
  noteLocalSnap();
  deps.setLastSentPos({ x: p.x, y: p.y, z: p.z });

  if (Number.isFinite(localPlayerState.health)) player.health = localPlayerState.health;
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

  deps.logger.debug(`Player state restored from gameState - pos(${localPlayerState.position.x.toFixed(1)},${localPlayerState.position.y.toFixed(1)},${localPlayerState.position.z.toFixed(1)}) vel(${localPlayerState.velocity?.x.toFixed(1) || 0},${localPlayerState.velocity?.y.toFixed(1) || 0},${localPlayerState.velocity?.z.toFixed(1) || 0}) health:${localPlayerState.health} dead:${localPlayerState.isDead}`);
}

/** Apply the probed saved map once the net ctx exists — structures,
 *  arena, interiors, albedo, sky. gameState that follows re-applies the
 *  same map for free or corrects it outright. */
export function bootApplySavedMap(ctx: NetCtx, map: MapSnapshot | null): void {
  if (map) {applyMapSnapshot(ctx, map);}
}
