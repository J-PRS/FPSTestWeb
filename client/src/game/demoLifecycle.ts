import { reconstructSeek, applyPlaybackEvents, releasePlaybackBeam, type PlaybackWorld } from '../demo/playbackReconstruction.js';
import { blendPlaybackBall } from '../demo/playbackTargets.js';
import {type ProjectileEvent, type TargetEvent, RemoteFrameFlags, TARGETTYPE_CREATURE_BASE, TARGETTYPE_KILL, demoSpeciesIndex, creatureDemoId, targetDemoId, ProjectileEventType, TEAM_NAME, CLS_NAME} from '../demo/types.js';
import type { RemoteSample } from '../demo/DemoRecorder.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import { isBotId } from '../../../shared/botNames.js';
import { applyStatusVisuals, applyTeamTint } from './remotes.js';
import { WIRE_SPECIES } from './netCrawlers.js';
import { FLAG_STAND_TOP } from '../structures/structures.js';
import { applyMapFog, applyWeather, applyAtmosphere, applyTerrain } from './net/mapAssets.js';
import type { DemoManager } from '../demo/index.js';
import type { InterpolatedRemote } from '../demo/DemoPlayer.js';
import type { Ball , Targetable } from '../entities/balls.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { FragMessages } from '../ui/FragMessages.js';
import type { HUD } from '../ui/hud.js';
import type { Player } from '../entities/Player.js';
import { noteLocalSnap } from './gameLoop.js';
import type { Projectile } from '../projectiles/Projectile.js';
import type { Terrain } from '../world/terrain.js';
import type * as THREE from 'three';
import { Vector3 as _V3 } from 'three';
import { ChildLogger } from '../core/Logger.js';
import type { WorldState } from './worldState.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { SLOT_DEFS } from '../weapons.js';

import { updatePlaybackCreatures, clearPlaybackCreatures, type PlaybackCreature } from '../demo/playbackCreatures.js';
import { clearPlaybackDeployables, type PlaybackDeployable } from '../demo/playbackDeployables.js';
import { clearPlaybackMarkers, updatePlaybackFlags } from '../demo/playbackMarkers.js';
import { hmapMatches, hmapToField } from '../demo/demoHmap.js';
import { feedMode } from '../feed/feedMode.js';
import { disposeSwings } from '../effects/swingTrails.js';
import { getHeightfield, injectHeightmapBytes, applyHeightfieldScale } from '../world/heightmap.js';
import * as sfxWorld from '../core/sfx/world.js';
import type { ViewModel } from '../entities/ViewModel.js';
import type { Crawler } from '../entities/Crawler.js';
import type { Scarab } from '../entities/Scarab.js';
import type { Gnat } from '../entities/Gnat.js';
import type { Snake } from '../entities/Snake.js';
import type { Baneling } from '../entities/Baneling.js';
import type { Turretter } from '../entities/Turretter.js';
import type { Roller } from '../entities/Roller.js';
import type { Seeker } from '../entities/Seeker.js';
import type { Overlord } from '../entities/Overlord.js';
import type { Mine } from '../entities/Mine.js';
import type { Totem } from '../entities/Totem.js';
import type { Rakk } from '../entities/Rakk.js';
import type { Buzzard } from '../entities/Buzzard.js';

const logger = new ChildLogger('DemoPlayback');

export interface DemoLifecycleDeps {
  lazyScene: () => THREE.Scene;
  lazyTerrain: () => Terrain;
  lazyCamera: () => THREE.PerspectiveCamera;
  lazyPlayer: () => Player;
  lazyDemoManager: () => DemoManager | null;
  lazyViewModel: () => ViewModel | null;
  lazyNetworkManager: () => NetworkManager;
  lazyWeather?: () => { setWeather(w?: unknown): void };
  damageNumberManager: () => DamageNumberManager;
  fragMessages: () => FragMessages;
  lazyHud: () => HUD;
  balls: Ball[];
  targets: Targetable[]; // balls+crawlers live here too - keep in sync on removal
  crawlers: Crawler[];
  scarabs: Scarab[];
  gnats: Gnat[];
  snakes: Snake[];
  banelings: Baneling[];
  turrets: Turretter[];
  rollers: Roller[];
  seekers: Seeker[];
  overlords: Overlord[];
  mines: Mine[];
  totems: Totem[];
  rakks: Rakk[];
  buzzards: Buzzard[];
  world: WorldState;
  overlay: HTMLElement;
  rendererCanvas: HTMLCanvasElement;
}

interface DemoLifecycleCtx extends DemoLifecycleDeps {
  playbackWorld: PlaybackWorld;
  playbackProjectiles: Projectile[];
  playbackProjectileById: Map<number, Projectile>;
  playbackBallById: Map<number, Ball>;
  playbackProjectileOrigin: Map<number, THREE.Vector3>;
  playbackRemotes: Map<number, RemotePlayer>;
  frozenWarn: { n: number };
  seekReconstructing: { on: boolean };
  /** flagMarkers/nodeMarkers entries playback minted - cleared with the
   *  clip so live markers don't inherit replayed state. */
  playbackFlagTeams: Set<string>;
  playbackNodeIds: Set<number>;
  /** wid currently mirrored onto the viewmodel - -1 means "not applied yet". */
  playbackWid: number;
  /** Restores the live heightmap after a clip's embedded terrain was
   *  injected for playback; null while the real map is up. */
  hmRestore: (() => void) | null;
}

function updatePlaybackProjectiles(d: DemoLifecycleCtx, dt: number): void {
  // Fade playback rail beams - pooled alongside the projectiles that spawn them.
  for (let i = d.playbackWorld.beams.length - 1; i >= 0; i -= 1) {
    const b = d.playbackWorld.beams[i];
    b.life -= dt;
    if (b.life <= 0) {
      d.lazyScene().remove(b.mesh);
      releasePlaybackBeam(d.playbackWorld, b);
      d.playbackWorld.beams.splice(i, 1);
    } else {
      b.mat.opacity = 0.85 * (b.life / b.maxLife);
    }
  }
  for (let i = d.playbackProjectiles.length - 1; i >= 0; i -= 1) {
    const r = d.playbackProjectiles[i];
    r.update(dt, d.lazyTerrain());
    if (r.dead) {
      r.dispose();
      d.playbackProjectiles.splice(i, 1);
      for (const [id, proj] of d.playbackProjectileById) {
        if (proj === r) {
          d.playbackProjectileById.delete(id);
          break;
        }
      }
    }
  }
}

// During playback: only update playback balls, skip live game balls and spawning
function updateBallsPlayback(d: DemoLifecycleCtx, dt: number): void {
  tickPlaybackBalls(d, dt);
  updatePlaybackCreatures(d.playbackWorld, dt);
  updatePlaybackFlags(d.playbackWorld);
  syncPlaybackFlagMarkers(d);
  syncPlaybackNodeMarkers(d);
}

function tickPlaybackBalls(d: DemoLifecycleCtx, dt: number): void {
  const terrain = d.lazyTerrain();
  const player = d.lazyPlayer();
  let frozenCount = 0;
  // playbackBallById keys the DEMO's targetId, not the ball's client-side
  // nextTargetId() - checking has(b.id) matched nothing and every playback
  // ball froze at its spawn pos. Iterate the map's own instances instead.
  for (const [demoId, b] of d.playbackBallById) {
    b.update(dt, terrain, player.pos);
    blendPlaybackBall(b, dt);
    // Detect frozen balls (near-zero velocity, not dead, not on ground resting)
    if (!b.dead && b.vel.lengthSq() < 0.01) {
frozenCount += 1;
    }
    if (b.disposed) {
      const bi = d.balls.indexOf(b);
      if (bi !== -1) {d.balls.splice(bi, 1);}
      const ti = d.targets.indexOf(b);
      if (ti !== -1) {d.targets.splice(ti, 1);}
      d.playbackBallById.delete(demoId);
    }
  }
  if (frozenCount > 0) {
d.frozenWarn.n += 1;
    if (d.frozenWarn.n <= 5 || d.frozenWarn.n % 60 === 0) {
      logger.debug(`${frozenCount} ball(s) frozen midair (vel~0). Total playback balls: ${d.playbackBallById.size}`);
    }
  } else {
    d.frozenWarn.n = 0;
  }
}

// HUD flag diamonds - the proxy already re-pins to the carrier each
// frame, so pointing marker.wirePos at the proxy rides the carrier too.
function syncPlaybackFlagMarkers(d: DemoLifecycleCtx): void {
  for (const [id, proxy] of d.playbackWorld.playbackFlags) {
    const team = (id & 0xF) === 1 ? 'bravo' : 'alpha';
    let m = d.world.flagMarkers.get(team);
    if (!m) {
      m = { mesh: proxy, stand: proxy, home: proxy.position.clone(), homeKnown: false, carrier: null, wirePos: proxy.position.clone() };
      d.world.flagMarkers.set(team, m);
      d.playbackFlagTeams.add(team);
    }
    m.wirePos.copy(proxy.position);
    if (proxy.userData.state === 0) {
      m.home.copy(proxy.position); m.homeKnown = true;
      m.wirePos.y += FLAG_STAND_TOP; // same home-lift the live feed applies
    }
    d.world.flagStates[team] = PB_FLAG_STATE[proxy.userData.state as number] ?? 'home';
  }
}

const PB_NODE_OWNER = ['neutral', 'alpha', 'bravo'] as const;

// Conquest node pins - recorded marker state decoded verbatim; the
// nodeMarkers projection tick (kept alive in playback mode) pins it.
// Nodes whose playback lane went quiet leave their pin behind - reap.
function syncPlaybackNodeMarkers(d: DemoLifecycleCtx): void {
  for (const [id, n] of d.playbackWorld.playbackNodes) {
    let m = d.world.nodeMarkers.get(id);
    if (!m) {
      m = { pos: new _V3(), owner: 'neutral', core: false, gx: 0, gz: 0, show: false, hot: false };
      d.world.nodeMarkers.set(id, m);
      d.playbackNodeIds.add(id);
    }
    m.pos.set(n.x, n.y, n.z);
    m.owner = PB_NODE_OWNER[n.meta & 3] ?? 'neutral';
    m.core = Boolean(n.meta & 4); m.gx = n.gx; m.gz = n.gz;
    m.show = Boolean(n.meta & 8); m.hot = Boolean(n.meta & 16);
  }
  for (const id of d.playbackNodeIds) {
    if (!d.playbackWorld.playbackNodes.has(id)) {
      d.world.nodeMarkers.delete(id);
      d.lazyHud().removePlayerIndicator(`node:${id}`);
      d.playbackNodeIds.delete(id);
    }
  }
}

const PB_FLAG_STATE = ['home', 'carried', 'dropped'] as const;

// Shared cleanup: dispose live + playback transient objects
const _pbMark = { x: 0, y: 0, z: 0 };
// Playback tint/weapon dedupe - per-clip memory like the live lastTintOf.
const pbTintOf = new Map<string, string>();
const pbWidOf = new Map<number, number>();
function clearTransientObjects(d: DemoLifecycleCtx): void {
  for (const rp of d.playbackRemotes.values()) {rp.dispose();}
  // Loop audio outlives the replica - each 'pb:' voice must release its
  // remoteMoveAudio slot or a stopped replay drones on.
  for (const idx of d.playbackRemotes.keys()) {
    sfxWorld.remoteMoveAudioGone(`pb:${idx}`);
    d.lazyHud().removePlayerIndicator(`pb:${idx}`);
  }
  d.playbackRemotes.clear();
  d.world.playbackRemotePlayers.clear();
  d.world.playbackPlayers.clear();
  pbTintOf.clear(); pbWidOf.clear();
  clearPlaybackMarkersOwned(d);
  for (const r of d.playbackProjectiles) {r.dispose();}
  d.playbackProjectiles.length = 0;
  d.playbackProjectileById.clear();
  d.playbackProjectileOrigin.clear();
  for (const ball of d.playbackBallById.values()) {
    ball.dispose();
    const idx = d.balls.indexOf(ball);
    if (idx !== -1) {d.balls.splice(idx, 1);}
    const ti = d.targets.indexOf(ball);
    if (ti !== -1) {d.targets.splice(ti, 1);}
  }
  d.playbackBallById.clear();
  clearPlaybackCreatures(d.playbackWorld);
  clearPlaybackDeployables(d.playbackWorld);
  clearPlaybackMarkers(d.playbackWorld);
  clearWorldFxLists(d);
  // Module-global swipe ribbons - not owned by any entity in `d`, so the
  // per-entity passes above can't reach them.
  disposeSwings();
}

// Playback-owned flag/node markers - remove so live flags reclaim the lane.
function clearPlaybackMarkersOwned(d: DemoLifecycleCtx): void {
  for (const team of d.playbackFlagTeams) {
    d.world.flagMarkers.delete(team as 'alpha' | 'bravo');
    d.lazyHud().removePlayerIndicator(`flag:${team}`);
    d.lazyHud().removePlayerIndicator(`stand:${team}`);
  }
  d.playbackFlagTeams.clear();
  for (const id of d.playbackNodeIds) {
    d.world.nodeMarkers.delete(id);
    d.lazyHud().removePlayerIndicator(`node:${id}`);
  }
  d.playbackNodeIds.clear();
  d.playbackWorld.playbackNodes.clear();
}

function clearWorldFxLists(d: DemoLifecycleCtx): void {
  for (const e of d.world.debrisList) {e.dispose();}
  d.world.debrisList.length = 0;
  for (const e of d.world.explosions) {e.dispose();}
  d.world.explosions.length = 0;
  for (const i of d.world.implosions) {i.dispose();}
  d.world.implosions.length = 0;
  for (const g of d.world.aoeGizmos) {g.dispose();}
  d.world.aoeGizmos.length = 0;
  for (const dd of d.world.playerDebrisList) {dd.dispose();}
  d.world.playerDebrisList.length = 0;
  for (const b of d.playbackWorld.beams) {
    d.lazyScene().remove(b.mesh);
    releasePlaybackBeam(d.playbackWorld, b);
  }
  d.playbackWorld.beams.length = 0;
}

// Snapshot existing alive balls into the demo recording - needed when recording
// starts after balls are already in the scene (they have no Spawned event yet).
function snapshotExistingBallsForRecording(d: DemoLifecycleCtx, onBallRecorded?: (ball: Ball) => void): void {
  const dm = d.lazyDemoManager();
  if (!dm?.isRecording) {return;}
  for (const ball of d.balls) {
    if (ball.dead) {continue;}
    dm.recordTargetSpawned(targetDemoId(ball), { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant);
    onBallRecorded?.(ball);
  }
}

// v5 HMAP: the clip carries its terrain - use it when the live field
// is absent or doesn't match the recorded action; the live map wins
// when it checks out against the embedded fingerprint.
function restoreClipHeightmap(d: DemoLifecycleCtx, demoManager: DemoManager): void {
  const emb = demoManager.player.demoData?.heightmap;
  if (!emb || d.hmRestore) {return;}
  const live = getHeightfield();
  if (live && hmapMatches(emb, live)) {return;}
  // hmapToField applies the corr tail (peak-preserving deltas on a
  // finer grid) — injecting the raw coarse bytes loses the bounce
  // fidelity the recorder paid bytes to keep.
  const ef = hmapToField(emb);
  d.hmRestore = injectHeightmapBytes(ef.data, ef.size, ef.heightScale ?? emb.heightScale, ef.worldScale ?? emb.worldScale);
  applyHeightfieldScale(d.lazyTerrain());
  d.lazyTerrain().reloadHeightmap();
  demoManager.ui.setStatus(live ? 'map mismatch - embedded terrain' : 'embedded terrain');
  logger.warn(live
    ? 'demo heightmap disagrees with live map - playing on embedded grid'
    : 'no live heightmap - playing on embedded grid');
}

// Dispose every live-game entity so nothing hangs frozen in the scene
// during playback — balls not owned by the clip, projectiles, species.
function disposeLiveEntities(d: DemoLifecycleCtx): void {
  const playbackBallSet = new Set(d.playbackBallById.values());
  for (let i = d.balls.length - 1; i >= 0; i -= 1) {
    const b = d.balls[i];
    if (!playbackBallSet.has(b)) {
      b.dispose();
      d.balls.splice(i, 1);
      const ti = d.targets.indexOf(b);
      if (ti !== -1) {d.targets.splice(ti, 1);}
    }
  }
  // Clear live projectiles
  for (const r of d.world.projectiles) {r.dispose();}
  d.world.projectiles.length = 0;
  // All live species are game objects too - dispose so they don't hang
  // frozen in the scene during playback
  for (const m of d.mines) {m.onDetonate = undefined;} // teardown isn't a detonation
  type DisposableTarget = Targetable & { dispose(): void };
  for (const list of [d.crawlers, d.turrets, d.rollers, d.seekers, d.overlords, d.mines, d.totems, d.rakks] as DisposableTarget[][]) {
    for (const e of list) {
      e.dispose();
      const ti = d.targets.indexOf(e);
      if (ti !== -1) {d.targets.splice(ti, 1);}
    }
    list.length = 0;
  }
}

function playbackStart(d: DemoLifecycleCtx, demoManager: DemoManager): void {
  // The replay is its own world - the live wire must not fight it
  d.world.playbackMode = true;
  // SECTION_ATMO: replay the recorded map look - without it a rimrock
  // clip rendered on caldera's map inherits the wrong haze/sky. Restored
  // to world.lastAtmo on stop.
  const atmo = demoManager.player.demoData?.atmo;
  if (atmo) {applyAtmoSection(d, atmo);}
  restoreClipHeightmap(d, demoManager);
  // Cool-shot clicks come from the overlay menu - a replay behind an
  // open menu is invisible. Close it and grab pointer lock (the click
  // is a user gesture, so the request is legal).
  d.overlay.style.display = 'none';
  document.body.classList.remove('menu-open');
  // The feed plays clips without a user gesture - pointer lock would
  // throw (and is meaningless there: no aiming, no input).
  if (!feedMode.on) {d.rendererCanvas.requestPointerLock()?.catch?.((): void => { return; });}
  // Live remote players would otherwise stand ghosted inside the replay
  for (const rp of d.world.remotePlayers.values()) {rp.setStaleHidden(true);}
  disposeLiveEntities(d);
  clearTransientObjects(d);
}

function playbackStop(d: DemoLifecycleCtx, demoManager: DemoManager, onPlaybackStop: () => void): void {
  d.world.playbackMode = false;
  // Re-arm so the next replay re-applies its own weapon instead of
  // inheriting whatever the previous clip left selected.
  d.playbackWid = -1;
  for (const rp of d.world.remotePlayers.values()) {rp.setStaleHidden(false);}
  // Hand the live sky/haze back - the clip's atmo was a guest.
  if (demoManager.player.demoData?.atmo) {
    applyAtmoSection(d, d.world.lastAtmo);
  }
  clearTransientObjects(d);
  // Show overlay menu so user can replay or pick another clip
  if (document.pointerLockElement === d.rendererCanvas) {
    document.exitPointerLock();
  }
  // Feed mode owns the screen - the menu must never resurface there.
  if (!feedMode.on) {
    d.overlay.style.display = 'flex';
    document.body.classList.add('menu-open'); // hides the HUD layer - same as overlayInput.setOverlay
  }
  demoManager.fetchCoolShotsFromServer();
  // Hand the live map back before recording resumes - a clip's embedded
  // grid must never leak into the next recording's HMAP trailer.
  if (d.hmRestore) {d.hmRestore(); d.hmRestore = null; applyHeightfieldScale(d.lazyTerrain()); d.lazyTerrain().reloadHeightmap();}
  // Resume recording for new cool shots - the feed never records.
  if (!feedMode.on) {demoManager.startRecording();}
  onPlaybackStop();
}

// SECTION_ATMO apply sequence — shared by playback start (clip's
// recorded look) and stop (hand the live map's look back).
function applyAtmoSection(d: DemoLifecycleCtx, atmo: unknown): void {
  const ctx = { deps: d } as never;
  const a = atmo as Record<string, unknown> | undefined;
  applyMapFog(ctx, a?.fog as never);
  applyWeather(ctx, a?.weather as never);
  applyAtmosphere(ctx, a?.atmosphere as never);
  applyTerrain(ctx, {
    file: (a?.terrain ?? null) as never, texPath: a?.terrainTex as never, skyDir: a?.sky as never,
    heightScale: a?.heightScale as never, tileSize: a?.tileSize as never, terrainPreset: a?.terrainPreset as never,
  })
    .catch((): void => undefined);
}

// Recorded remote players - states arrive already interpolated at demo
// time; RemotePlayer's own snapshot buffer gets them as live updates,
// so replica smoothing is literally the production netcode path.
// One interpolated remote state → replica update + HUD mirror +
// positional move audio (playback bypasses net/remotes.ts).
// Overhead chevron + cosmetics for one playback remote - bypasses
// net/remotes.ts where the live HUD marker updates, so without this
// replayed bodies walk around unmarked. Same renderLift anchor as live.
// Roster-declared weapon rides the wire bit - only re-arm the model
// viewmodel when the clip's wid actually changed.
function syncPlaybackWeapon(s: InterpolatedRemote, rp: RemotePlayer): void {
  if (s.wid === undefined || s.wid === pbWidOf.get(s.rosterIdx)) {return;}
  pbWidOf.set(s.rosterIdx, s.wid);
  rp.model.setWeapon(s.wid);
}

function remotePlaybackHud(d: DemoLifecycleCtx, s: InterpolatedRemote, rp: RemotePlayer, dead: boolean, pos: { x: number; y: number; z: number }, roster: ReturnType<DemoManager['getRoster']>): void {
  const indId = `pb:${s.rosterIdx}`;
  const hud = d.lazyHud();
  const teamName = s.team ? TEAM_NAME[s.team] : undefined;
  if (s.cls && rp.armorClass !== CLS_NAME[s.cls]) {rp.setClass(CLS_NAME[s.cls]);}
  // Same cosmetic lanes the live tick drives: status auras/cloak,
  // team tint, held-token crown, roster-declared weapon.
  const visible = applyStatusVisuals(d.world.localTeam, hud, null, indId, rp, s.status ?? 0, teamName);
  applyTeamTint(d.world.localTeam, pbTintOf, indId, rp, teamName);
  rp.setHeld(s.held ?? 0);
  syncPlaybackWeapon(s, rp);
  if (dead || !visible) {hud.removePlayerIndicator(indId); return;}
  _pbMark.x = rp.position.x; _pbMark.y = rp.position.y + rp.renderLift; _pbMark.z = rp.position.z;
  const rid = roster[s.rosterIdx] ?? indId;
  // Roster-keyed mirrors - health bars read playback actors through
  // the same maps the wire roster feeds them live.
  d.world.playbackRemotePlayers.set(rid, rp);
  d.world.playbackPlayers.set(rid, { position: pos, isDead: dead, health: s.hp, team: teamName });
  hud.updatePlayerIndicator(indId, _pbMark, d.lazyCamera(), {
    friendly: Boolean(teamName) && teamName === d.world.localTeam,
    sheep: s.sheep, bot: isBotId(rid), cls: CLS_NAME[s.cls ?? 0] ?? rp.armorClass,
    hp: s.hp || undefined, held: s.held || undefined,
    name: rid,
  });
}

function remotePlaybackState(d: DemoLifecycleCtx, s: InterpolatedRemote, dt: number, roster: ReturnType<DemoManager['getRoster']>): void {
  let rp = d.playbackRemotes.get(s.rosterIdx);
  const pos = { x: s.posX, y: s.posY, z: s.posZ };
  if (!rp) {
    rp = new RemotePlayer(d.lazyScene(), roster[s.rosterIdx] ?? `remote${s.rosterIdx}`, pos, d.lazyTerrain());
    d.playbackRemotes.set(s.rosterIdx, rp);
  }
  rp.update(pos, { yaw: s.yaw, pitch: s.pitch }, dt, 0, { x: s.velX, y: s.velY, z: s.velZ });
  rp.tick(dt, d.lazyCamera().position);
  const dead = (s.flags & RemoteFrameFlags.Dead) !== 0;
  rp.setStaleHidden(dead);
  remotePlaybackHud(d, s, rp, dead, pos, roster);
  // Playback remotes bypass net/remotes.ts, which is where jet/ski
  // audio normally fires - replay the same positional loop decision.
  // No wireJet bit in the recording, so the powered-climb heuristic
  // stands in for it; the ski bit IS recorded.
  sfxWorld.remoteMoveAudio(`pb:${s.rosterIdx}`, rp.position, rp.vel.length(),
    !dead && s.velY > 4.5, !dead && (s.flags & RemoteFrameFlags.Ski) !== 0,
    rp.vel, rp.armorClass ?? 'medium');
}

function remotePlayback(d: DemoLifecycleCtx, demoManager: DemoManager, states: InterpolatedRemote[], dt: number): void {
  const roster = demoManager.getRoster();
  const seen = new Set<number>();
  for (const s of states) {
    seen.add(s.rosterIdx);
    remotePlaybackState(d, s, dt, roster);
  }
  // Roster players absent at this time keep their replica but hidden -
  // e.g. they joined after the seek target or hadn't spawned yet.
  for (const [idx, rp] of d.playbackRemotes) {
    if (!seen.has(idx)) {
      rp.setStaleHidden(true);
      sfxWorld.remoteMoveAudioGone(`pb:${idx}`);
      d.lazyHud().removePlayerIndicator(`pb:${idx}`);
      const rid = roster[idx];
      if (rid) {d.world.playbackRemotePlayers.delete(rid); d.world.playbackPlayers.delete(rid);}
    }
  }
}

function wireDemoHandlers(d: DemoLifecycleCtx, demoManager: DemoManager, onPlaybackStop: () => void): void {
  // Handle projectile events from demo playback: spawn projectiles on Fired, explode on Destroyed
  demoManager.onPlaybackEvent = (events: { projectiles: ProjectileEvent[], targets: TargetEvent[] }): void => {
    if (d.seekReconstructing.on) {
      reconstructSeek(d.playbackWorld, events, demoManager.currentTime);
      d.seekReconstructing.on = false;
      return;
    }
    // Muzzle kick rides the same Fired events that spawn the projectiles -
    // the recorded weapon in frame and the shot stay in sync because they
    // share one timestamp stream. Only the LOCAL player's shots kick:
    // remote-owned Fired events carry shooter rosterIdx+1 in targetId, and
    // kicking for all 19 other guns is an every-shot camera judder.
    const vm = d.lazyViewModel();
    if (vm) {
      for (const e of events.projectiles) {
        if (e.eventType === ProjectileEventType.Fired && e.targetId === 0) {vm.kick();}
      }
    }
    applyPlaybackEvents(d.playbackWorld, events);
    // Kill feed - TARGETTYPE_KILL carries victim rosterIdx, shooter
    // rosterIdx+1 in peakPosX, weapon in health. Teams aren't in the
    // roster stream; leave them neutral rather than guessing.
    for (const ev of events.targets) {
      if (ev.targetType !== TARGETTYPE_KILL) {continue;}
      const roster = demoManager.getRoster();
      const localId = d.lazyNetworkManager().getLocalPlayerId();
      const targetId = roster[ev.targetId] ?? `player${ev.targetId}`;
      const shooterId = ev.peakPosX > 0 ? (roster[ev.peakPosX - 1] ?? 'environment') : 'environment';
      d.lazyHud().feedKill(shooterId, targetId, shooterId === localId, targetId === localId,
        { weapon: ev.health || undefined, sName: shooterId, tName: targetId });
    }
  };
  demoManager.onPlaybackState = (state): void => {
    if (demoManager.isPlaying) {
      const player = d.lazyPlayer();
      player.pos.set(state.posX, state.posY, state.posZ);
      noteLocalSnap(); // replayed trajectory isn't a physics snap - scrubbing included
      player.vel.set(state.velX, state.velY, state.velZ);
      player.yaw = state.yaw;
      player.pitch = state.pitch;
      // HUD bars replay the recorded body - v≤7 files carry 0s, so leave
      // the live values alone rather than pinning them to zero.
      if (state.health || state.armor) {player.health = state.health; player.armor = state.armor;}
      // Mirror the recorded held weapon onto the viewmodel - switchWeapon
      // takes the wire weaponType (the same ids frames carry), NOT a
      // loadout slot. Unknown ids (a weapon deleted since recording)
      // fall back to the stock launcher.
      const vm = d.lazyViewModel();
      if (vm) {
        const wid = SLOT_DEFS.some((def): boolean => def.weaponType === state.weaponType) ? state.weaponType : 0;
        if (wid !== d.playbackWid) { d.playbackWid = wid; vm.switchWeapon(wid); }
      }
    }
  };

  // Demo playback ends - just pause, keep objects visible (frozen)
  demoManager.onPlaybackEnd = (): void => {
    // No cleanup - objects stay visible as if user pressed pause.
    // Cleanup happens when user explicitly stops playback via ESC.
    demoManager.finishExportIfArmed();
  };

  // User explicitly stops playback (ESC, UI stop button) - full cleanup
  demoManager.onPlaybackStop = (): void => {playbackStop(d, demoManager, onPlaybackStop);};

  // Clear live game objects when playback starts so they don't hang frozen in the scene
  demoManager.onPlaybackStart = (): void => {playbackStart(d, demoManager);};

  // Clear playback projectiles on seek so they don't get orphaned
  demoManager.onPlaybackSeek = (): void => {
    d.seekReconstructing.on = true;
    clearTransientObjects(d);
  };

  // Recorded remote players - states arrive already interpolated at demo
  // time; RemotePlayer's own snapshot buffer gets them as live updates,
  // so replica smoothing is literally the production netcode path.
  demoManager.onRemotePlayback = (states, dt): void => {remotePlayback(d, demoManager, states, dt);};

  // Offline clip render advances playback projectiles/beams by step-dt,
  // not the wall dt the game loop hands updatePlaybackProjectiles.
  demoManager.onPlaybackTick = (dt: number): void => { updatePlaybackProjectiles(d, dt); };
  d.playbackWorld.playbackMatchMeta = (ev): void => {
    d.world.teamScores = { alpha: ev.peakPosX, bravo: ev.peakPosY };
    // Deadline in wall-clock = remaining-ms minus demo time elapsed
    // since the event - scrubbing backward re-arms honestly.
    d.world.matchEndsAt = Date.now() + ev.health - ((demoManager.currentTime ?? ev.timestamp) - ev.timestamp) * 1000;
  };

  // Recording source: every remote player the world knows about. Bot
  // entries ('bot:'-prefixed) ride along too - they're in the same map.
  // The sample buffer + objects are reused between calls - the recorder
  // consumes them synchronously, and ~160 allocs/s of throwaway structs
  // was the recorder's last GC churn.
  const remoteSampleBuf: RemoteSample[] = [];
  demoManager.setRemoteSource((): RemoteSample[] => {
    const out = remoteSampleBuf;
    const wire = d.lazyNetworkManager().getPlayers();
    let i = 0;
    for (const [id, rp] of d.world.remotePlayers) {
      let s = out[i];
      if (!s) {
        s = { id: '', posX: 0, posY: 0, posZ: 0, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0, dead: false, ski: false };
        out[i] = s;
      }
      s.id = id;
      s.posX = rp.position.x; s.posY = rp.position.y; s.posZ = rp.position.z;
      s.velX = rp.vel.x; s.velY = rp.vel.y; s.velZ = rp.vel.z;
      s.yaw = rp.rotation.yaw; s.pitch = rp.rotation.pitch;
      s.dead = rp.isDead; s.ski = false;
      // Meta lives on the wire state, not the replica - same fields the
      // live HUD indicator lane reads.
      const w = wire.get(id);
      s.team = w?.team; s.health = w?.health; s.held = w?.held;
      s.sheep = w?.sheep; s.armorClass = w?.armorClass;
      s.status = w?.status; s.weapon = w?.weapon;
      i += 1;
    }
    out.length = i;
    return out;
  });

  // Live target sweep - every ball + creature the world renders. Clip
  // extraction rebuilds baseline spawns from the recorder's event ring,
  // and an entity whose lifecycle edges aged out (spawned >30s ago,
  // quiet since) is invisible to it: the demo then silently drops it.
  // A 2s StateChanged sweep keeps a recent truth in the ring so any
  // window anywhere in the buffer replays the full field.
  const zeroVel = { x: 0, y: 0, z: 0 };
  demoManager.setTargetSnapshotSource(function* () {
    for (const b of d.balls) {
      if (b.dead) {continue;}
      // Net balls keep their client id in the 0x40xx namespace while every
      // recorded edge keys on the wire netId - emit the wire id or the
      // baseline pass resurrects a phantom second ball.
      yield { targetId: targetDemoId(b), targetType: b.variant, pos: b.pos, vel: b.vel, health: b.health };
    }
    for (const [species, w] of Object.entries(WIRE_SPECIES)) {
      const list = d[w.ctxKey] as { netId: number; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } | null }[];
      const tt = TARGETTYPE_CREATURE_BASE + demoSpeciesIndex(species);
      for (const c of list) {
        if (c.netId <= 0) {continue;} // local sims aren't wire entities - the offline lane doesn't record them either
        yield { targetId: creatureDemoId(c.netId), targetType: tt, pos: c.pos, vel: c.vel ?? zeroVel, health: 0 };
      }
    }
  });
}

// Demo playback lifecycle: owns the playback projectile/ball registries and
// wires all onPlayback* handlers (events, state, start/stop/seek/end).
export function createDemoLifecycle(deps: DemoLifecycleDeps) {
  const playbackProjectiles: Projectile[] = [];
  const playbackProjectileById = new Map<number, Projectile>();
  const playbackBallById = new Map<number, Ball>();
  const playbackCreatureById = new Map<number, PlaybackCreature>();
  const playbackDeployableById = new Map<number, PlaybackDeployable>();
  const playbackFlags = new Map<number, THREE.Group>();
  const playbackPickups = new Map<number, { mesh: THREE.Object3D; dispose(scene: THREE.Scene): void }>();
  const playbackRemotesMap = new Map<number, RemotePlayer>();
  const playbackProjectileOrigin = new Map<number, THREE.Vector3>();

  const playbackWorld: PlaybackWorld = {
    get scene(): THREE.Scene<THREE.Object3DEventMap> { return deps.lazyScene(); },
    get terrain(): Terrain { return deps.lazyTerrain(); },
    get camera(): THREE.PerspectiveCamera { return deps.lazyCamera(); },
    getPlayer: (): Player => deps.lazyPlayer(),
    balls: deps.balls,
    debrisList: deps.world.debrisList,
    explosions: deps.world.explosions,
    implosions: deps.world.implosions,
    playbackBallById,
    playbackCreatureById,
    playbackDeployableById,
    playbackFlags,
    playbackNodes: new Map(),
    playbackPickups,
    remotePosAt: (rosterIdx): THREE.Vector3 | null => playbackRemotesMap.get(rosterIdx)?.position ?? null,
    playbackProjectiles,
    playbackProjectileById,
    playbackProjectileOrigin,
    beams: [],
    beamPool: [],
    get damageNumberManager(): DamageNumberManager { return deps.damageNumberManager(); },
    get fragMessages(): FragMessages { return deps.fragMessages(); },
    get hud(): HUD { return deps.lazyHud(); },
  };

  const d: DemoLifecycleCtx = Object.assign(deps, {
    playbackProjectiles,
    playbackProjectileById,
    playbackBallById,
    playbackProjectileOrigin,
    // Recorded remote players replayed as real RemotePlayer replicas - their
    // snapshot buffer smooths the 20Hz samples exactly like live net code.
    playbackRemotes: playbackRemotesMap,
    frozenWarn: { n: 0 },
    seekReconstructing: { on: false },
    playbackWid: -1,
    playbackFlagTeams: new Set<string>(),
    playbackNodeIds: new Set<number>(),
    playbackWorld,
    hmRestore: null,
  });

  return {
    playbackWorld,
    playbackBallById,
    updatePlaybackProjectiles: (dt: number): void => updatePlaybackProjectiles(d, dt),
    updateBallsPlayback: (dt: number): void => updateBallsPlayback(d, dt),
    snapshotExistingBallsForRecording: (cb?: (ball: Ball) => void): void => snapshotExistingBallsForRecording(d, cb),
    wireDemoHandlers: (dm: DemoManager, onStop: () => void): void => wireDemoHandlers(d, dm, onStop),
  };
}
