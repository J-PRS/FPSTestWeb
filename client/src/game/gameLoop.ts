import * as THREE from 'three';
import Stats from 'stats.js';

import { MAX_DELTA_TIME } from '../core/config.js';
import { urlParams, isDevHost } from '../core/params.js';
import type { DemoManager } from '../demo/index.js';
import type { Player } from '../entities/Player.js';
import { updateGibs, getShadows } from '../entities/swarms.js';
import { updateSwings } from '../effects/swingTrails.js';
import type { ViewModel } from '../entities/ViewModel.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { EffectsManager } from '../effects/effects.js';
import type { SpeedLines } from '../effects/speedLines.js';
import type { AmbientParticles } from '../effects/ambientParticles.js';
import type { GroundMist } from '../effects/groundMist.js';
import type { AmbientBirds } from '../effects/birds.js';
import { screenShake } from '../effects/screenShake.js';
import { Explosion } from '../effects/explosion.js';
import { updateVfx } from '../effects/vfx.js';
import { collectDiag } from '../core/fxDiag.js';
import '../core/visAudit.js'; // side-effect: registers the Alt+Q visAudit section
import { setLogOverlayVisible } from '../ui/logPanel.js';
import { setDebugOverlays } from '../ui/hud/indicators.js';
import { reportHudOverlap } from '../ui/overlapAudit.js';
import { installGeoNaNWatch } from '../core/geoNaN.js';
import * as sfxAudio from '../core/sfx/world.js';

import type { NetworkManager } from '../networking/NetworkManager.js';
import type { HUD } from '../ui/hud.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { createScene } from '../world/scene.js';
import { updateDirectionalFog, fogHorizon, syncFxFog } from '../world/directionalFog.js';
import { updateCubeSky, getInteriorsEpoch } from './net/mapAssets.js';
import { isSessionVeiled, dropSessionVeil, isSessionVeilReady } from './net/world.js';
import { refreshColliderGizmoVisibility } from '../world/mapStructures.js';
import type { createRenderer } from '../core/renderer.js';
import type { Terrain } from '../world/terrain.js';
import type { createEntities } from './entities.js';
import type { createCombat } from './combat.js';
import type { createDemoLifecycle } from './demoLifecycle.js';
import type { createRemotes } from './remotes.js';
import type { createWaveDirector } from './waveDirector.js';
import type { WorldState } from './worldState.js';
import type { MinimapPlayer } from '../ui/minimap.js';
import { createPerfHud } from '../core/perfHud.js';
import { createFrameBudget } from '../core/frameBudget.js';
import { gpuBegin, gpuEnd, gpuMs } from '../core/gpuTimer.js';
import { lastWeaponByPlayer } from './net/projectiles.js';
import { fpsWatchdog, resetAutoQuality, fxJobSample, fxJobStats } from './loopPerf.js';
import { createRenderScan } from './renderScan.js';
import { settings } from '../core/settings.js';
import { WeaponType } from '../../../shared/weapons.js';
import { classCapsule, classMass } from '../../../shared/botClasses.js';
import type { BodyCapsule } from '../../../shared/movement.js';
import { isBotId } from '../../../shared/botNames.js';
import { nanScanTick, nanScanBindProbe } from '../core/nanScan.js';
import Logger from '../core/Logger.js';

const _zeroVel = new THREE.Vector3(); // shared zero for demo playback
const _sunDir = new THREE.Vector3(); // scratch — directional fog sun lookup
// Frame-jump forensic: compare pos at the same point each frame so any
// discontinuity — respawn, correction, teleport — lands in the log with
// its from→to pair. Honest skiing is ~2-4m/frame even at 30fps; 8m only
// fires on a real snap.
const _posPrev = new THREE.Vector3();
let _posPrimed = false;

/** Authoritative reseats (respawn, correction, gameState restore, journal
 *  rewind) teleport the body by design — the frame-jump watch must not
 *  read them as physics snaps. Snap paths call this after pos.set. */
export function noteLocalSnap(): void {
  _posPrimed = false;
}
const JUMP_FRAME_M = 8;
// Knocked/skied hard enough to teleport = real teleport class, but a jet
// burst + downhill ski can legitimately clear 8m mid-frame — spam once/s
// max, the jump itself still counts every time via _posPrev tracking.
let _posJumpLastAt = 0;
const _birdPosBuf: THREE.Vector3[] = []; // scratch — minimap debug blips
const _selfShadowOwner = { swarmSlot: -1, shadowSlot: -1 }; // self blob — shared instanced pool slot
const _selfShadowPos = new THREE.Vector3();
const _mapBlips: MinimapPlayer[] = []; // scratch — minimap player/bot blips

// ?mode=classic — solo bounce-and-shoot: balls only, no rage, no roster
const CLASSIC_MODE = urlParams.isClassic;
// ?nanscan=1 — see fxTick; hunts the screen-covering-triangle flash.
const NANSCAN = urlParams.get('nanscan') === '1';
let nanProbeBound = false;

// Dead-checkable effect list — update each, dispose+splice the finished.
function updateDeadList<T extends { update(dt: number): void; dead: boolean; dispose(): void }>(list: T[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    list[i]?.update(dt);
    if (list[i]?.dead) { list[i]?.dispose(); list.splice(i, 1); }
  }
}

const _aliveCount = (l: { dead: boolean }[]) => { let n = 0; for (const e of l) {if (!e.dead) {n += 1;}} return n; };

// Live-explosion ceiling — a busy room stacks blasts until particles
// and draw calls crush the frame (seen: 155 live, 30k particles). Past
// the cap the oldest is retired early; it loses only its tail frames.
const MAX_LIVE_EXPLOSIONS = 48;
const VFX_NEAR_SQ = 260 * 260;

export interface GameLoopDeps {
  camera: THREE.PerspectiveCamera;
  sceneSetup: ReturnType<typeof createScene>;
  rendererSetup: ReturnType<typeof createRenderer>;
  lazyTerrain: () => Terrain;
  lazyPlayer: () => Player;
  lazyViewModel: () => ViewModel;
  vmScene: () => THREE.Scene;
  vmCamera: () => THREE.PerspectiveCamera;
  lazyHud: () => HUD;
  lazyHealthBarSystem: () => HealthBarSystem;
  damageNumberManager: () => DamageNumberManager;
  lazyNetworkManager: () => NetworkManager;
  lazyDemoManager: () => DemoManager | null;
  lazyEffects: () => EffectsManager;
  speedLines: SpeedLines;
  ambientLayers: AmbientParticles[];
  groundMist: () => GroundMist;
  ambientBirds: AmbientBirds;
  entities: ReturnType<typeof createEntities>;
  combat: () => ReturnType<typeof createCombat>;
  remotes: () => ReturnType<typeof createRemotes>;
  demoLifecycle: () => ReturnType<typeof createDemoLifecycle>;
  waveDirector: () => ReturnType<typeof createWaveDirector>;
  /** ?mode=nuggets — Nugget Wars bot manager; null otherwise. */
  teamBots?: () => { update(dt: number): void } | null;
  world: WorldState;
  // ?dummy debug hook — null when the param isn't set
  getDummyTick: () => ((dt: number) => void) | null;
  /** Local sheep meter — ticks each frame from hudTick so the crosshair
   *  readout and scoreboard self-row share the smoothed value. */
  lazyPlayerSheep?: () => import('./playerSheep.js').PlayerSheep;
}

// The frame loop + render pass. Everything mutable it touches comes in via
// deps so main.ts stays a pure wiring file.
export interface LoopState {
  lastYaw: number;
  lastPitch: number;
  lowFpsFrames: number;
  lowFpsAccum: number;
  lastFpsDump: number;
  /** Dynamic quality levels — render cost (0=full … 5=cheapest) and CPU
   *  cost (0=all ambient work … 2=stripped). Chosen per dump by whether
   *  JS phases or raster dominated the slow frames: a CPU-throttled box
   *  gains nothing from a smaller framebuffer. */
  gpuLevel: number;
  cpuLevel: number;
  cpuBound: boolean;
  /** Wall-clock accumulator of >55fps frames — step-up hysteresis so a
   *  brief smooth burst doesn't bounce quality up and down. */
  headroomAccum: number;
  /** True when the current pixel mode was set by auto-scaling, not the
   *  user — auto-set modes must not read as a pinned user choice. */
  autoPixel: boolean;
  fxCursor: number;
  fxJobs: [name: string, run: () => void][];
  /** Shadow-map throttle accumulator — see renderFrame. */
  shadowAcc: number;
  /** FPS-cap render skip accumulator — see loop. */
  renderAcc: number;
  /** Cached interior meshes for the per-frame shadow-caster distance
   *  gate — populated once the __t2interiors group exists, and re-
   *  censused whenever applyInteriors swaps it (map change disposes
   *  the old meshes; a stale cache would gate corpses forever). */
  interiorCasters?: THREE.Mesh[];
  interiorEpoch?: number;
  /** Frames rendered before the shader warmup fires — lets async content
   *  (interiors, rigs) land in the scene before compileAsync runs. */
  warmN: number;
  warmed: boolean;
  /** Post-warmup recompile countdown — arms when the remote roster
   *  changes so late-loading rigs still get a parallel compile pass
   *  instead of hitching their first visible frame. */
  rewarmT?: number;
  lastRemoteCount?: number;
  /** Veil warmup — sub-26ms frames rendered behind the session veil.
   *  The veil drops only once gameState landed AND frames are stable,
   *  so first-draw compiles/uploads happen off the player's clock. */
  veilStable: number;
  veilFrames: number;
  /** Boot warmup — same stability signal as the veil, but for the
   *  un-veiled start: offline modes gate their spawn/roster kick-off on
   *  whenStable() so the game doesn't begin mid-hitch. */
  bootStable: number;
  bootFrames: number;
  bootStableResolvers: (() => void)[];
}

// fxJob EMA/max bookkeeping lives in loopPerf — see fxJobSample there.

// Demo bookkeeping: update recorder/player, freeze input during playback.
// Returns whether demo playback is currently paused. Only unfreezes what
// tickDemo froze — the boot warmup gate holds the lock independently.
let demoOwnsFreeze = false;
function tickDemo(deps: GameLoopDeps, dt: number): boolean {
  const demoManager = deps.lazyDemoManager();
  const player = deps.lazyPlayer();
  if (demoManager) {demoManager.update(dt);} // zero-overhead when idle
  const shouldFreeze = demoManager?.isPlaying ?? false;
  if (shouldFreeze && !player.inputFrozen) {player.freezeInput(); demoOwnsFreeze = true;}
  else if (!shouldFreeze && demoOwnsFreeze) {player.unfreezeInput(); demoOwnsFreeze = false;}
  return demoManager?.isPaused ?? false;
}

// Species census for the bottom-left debug readout — in-place count,
// no per-frame filter arrays.
function censusEntities(deps: GameLoopDeps, entities: ReturnType<typeof createEntities>) {
  let balls = 0, elites = 0;
  for (const b of entities.balls) {
    if (b.dead || b.disposed) {continue;}
    if (b.variant === 3) {elites += 1;} else {balls += 1;}
  }
  return {
    balls, elites,
    crawlers: _aliveCount(entities.crawlers),
    scarabs: _aliveCount(entities.scarabs),
    grubs: _aliveCount(entities.grubs),
    snakes: _aliveCount(entities.snakes),
    gnats: _aliveCount(entities.gnats),
    seekers: _aliveCount(entities.seekers),
    rakks: _aliveCount(entities.rakks),
    rollers: _aliveCount(entities.rollers),
    turrets: _aliveCount(entities.turrets),
    overlords: _aliveCount(entities.overlords),
    totems: _aliveCount(entities.totems),
    mines: _aliveCount(entities.mines),
    targets: _aliveCount(entities.targets),
    projectiles: deps.world.projectiles.length,
    fx: deps.world.debrisList.length + deps.world.explosions.length
      + deps.world.implosions.length + deps.world.scorches.length
      + deps.world.splats.length,
  };
}

// Fog uniforms ride the terrain shader — must sync every frame. Fog color
// follows the sun: looking sunward warms the haze, away cools it; the sky
// horizon uniform takes the same tint so fogged ground stays seamless.
function syncFog(deps: GameLoopDeps, terrain: Terrain): void {
  const {fog} = deps.sceneSetup.scene;
  if (!(fog instanceof THREE.Fog)) {return;}
  _sunDir.copy(deps.sceneSetup.sun.position).normalize();
  const tinted = updateDirectionalFog(fog, deps.camera, _sunDir);
  fog.color.copy(tinted);
  deps.sceneSetup.atmosphericSky.setFogColor(tinted);
  deps.sceneSetup.atmosphericSky.setHorizonColor(fogHorizon() ?? tinted);
  updateCubeSky(deps.camera, fog.color);
  refreshColliderGizmoVisibility();
  // F1 terrain overlay — cyan wire on the drawn clipmap, yellow wire
  // patch on the collider lattice around the player.
  const pp = deps.lazyPlayer().pos;
  terrain.setDebugWire(urlParams.debug, pp.x, pp.z);
  terrain.updateFog(fog.color, fog.near, fog.far);
  syncFxFog(fog); // world-space ShaderMaterials share the same range
}

/** Contact bodies the local player's prediction resolves against —
 *  refilled each frame so the sim matches the server's shadow. */
const _contactBodies: BodyCapsule[] = [];

/** Stage 1 — world sim: player, terrain, entities, wave director,
 *  projectiles. Returns demoPaused for the later stages. */
interface TickFrame { dt: number; player: Player; networkManager: NetworkManager; demoManager: DemoManager | null }
const fmtBps = (b: number) => b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)}MB/s` : b >= 1024 ? `${(b / 1024).toFixed(1)}KB/s` : `${Math.round(b)}B/s`;
function simTick(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, f: TickFrame, terrain: Terrain): boolean {
  const { dt, player, demoManager, networkManager } = f;
  // Offline pause: a hidden tab rAFs ~1/s, so the local match would crawl
  // at 5% speed and bots keep slowly fighting — a real pause matches user
  // intent. Online rooms must keep simulating: the server doesn't stop.
  if (document.hidden && !networkManager.isConnected()) {return false;}
  // Player-vs-player contact: remotes + lobby bots all live in this set —
  // corpses don't block. Interpolated positions are a half-RTT stale but
  // the push only has to agree with the shadow's, not be perfect.
  let bodyN = 0;
  for (const rp of deps.world.remotePlayers.values()) {
    if (rp.isDead) {continue;}
    // Reused pool — fresh 7-field structs per remote per frame were
    // steady GC churn alongside the blip fill below.
    let b = _contactBodies[bodyN];
    if (!b) { b = { x: 0, y: 0, z: 0, h: 0, mass: 0, r: 0, vx: 0, vz: 0 }; _contactBodies.push(b); }
    const caps = classCapsule(rp.armorClass);
    b.x = rp.pos.x; b.y = rp.pos.y; b.z = rp.pos.z;
    b.h = caps.eye; b.mass = classMass(rp.armorClass); b.r = caps.radius;
    b.vx = rp.vel.x; b.vz = rp.vel.z;
bodyN += 1;
  }
  _contactBodies.length = bodyN;
  player.movement.bodies = _contactBodies;
  // Gate shields read team off the sim state — keep it synced to the
  // wire team (rebalances/teamUpdate can flip it mid-match).
  player.movement.getState().team = deps.world.localTeam;
  player.update(dt);
  if (_posPrimed) {
    const jump = player.pos.distanceTo(_posPrev);
    if (jump > JUMP_FRAME_M && performance.now() - _posJumpLastAt > 1000) {
      _posJumpLastAt = performance.now();
      Logger.warn(`POS JUMP ${jump.toFixed(1)}m in one frame — (${_posPrev.x.toFixed(1)},${_posPrev.y.toFixed(1)},${_posPrev.z.toFixed(1)}) → (${player.pos.x.toFixed(1)},${player.pos.y.toFixed(1)},${player.pos.z.toFixed(1)}) dead=${player.isDead}`);
    }
  }
  _posPrev.copy(player.pos);
  _posPrimed = true;
  terrain.update(player.pos.x, player.pos.z);
  syncFog(deps, terrain);

  // Position send even when hidden — the server needs liveness. Runs
  // unconditionally: sends no-op while disconnected (ws?.connected()
  // guards inside), but gating the whole tick on the socket froze every
  // remote/bot indicator mid-screen for the life of a flap.
  // Remotes keep ticking while you're dead — the death cam still watches
  // the world, and the position send is also the server's liveness proof.
  if (!demoManager?.isPlaying) {
    deps.remotes().networkTick(dt);
  }
  perf.mark('player');

  const demoPaused = tickDemo(deps, dt);
  if (demoPaused) {return true;}

  tickEntities(deps, perf, dt, demoManager?.isPlaying ?? false);
  return false;
}

function tickEntities(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, dt: number, demoPlaying: boolean): void {
  const {entities} = deps;
  entities.updateBalls(dt);
  perf.mark('balls');
  // ?mode=classic — balls are the whole roster, every other species'
  // tick is skipped (they self-spawn ambiently, so ticking = populating)
  if (!CLASSIC_MODE) {
    entities.updateSpeciesAll(dt);
    entities.updateDeployables(dt);
  }
  perf.mark('species');
  // Ambient population is an offline feature — connected rooms own
  // their balls/creatures on the wire; the director spawning locals
  // alongside them was the busy double-population on join.
  if (!demoPlaying && !deps.lazyNetworkManager().isConnected()) {deps.waveDirector().update(dt);}
  if (!demoPlaying) {entities.updateNuggets(dt);}
  deps.teamBots?.()?.update(dt);
  perf.mark('bots');
  if (!demoPlaying) {deps.combat()?.updateProjectiles(dt);}
  deps.demoLifecycle().updatePlaybackProjectiles(dt);
  perf.mark('proj');
}

/** Stage 2 — transient VFX on wall-clock fxDt so they decay while the
 *  tab is hidden instead of stacking into an overdraw bomb. Profiled the
 *  hottest stage under fire (~5ms in a debris storm): the list updates
 *  run as budgeted jobs under an ms cap, rotated each frame so sustained
 *  load starves every list evenly instead of tail-dropping the last two.
 *  Skipped frames are absorbed by the dt-based decay. */
const FX_MS_CAP = 1.2;
function fxTick(deps: GameLoopDeps, st: LoopState, budget: ReturnType<typeof createFrameBudget>, fxDt: number): void {
  // vfx runs OUTSIDE the rotation: batcher.update must tick every frame
  // (particles freeze otherwise) and its bookkeeping is what keeps the
  // sim bounded — deferring it under load let `live` balloon past the
  // old cap (seen: 1201 systems → 10-24ms vfx frames).
  const v0 = performance.now();
  updateVfx(fxDt, deps.camera.position);
  fxJobSample('vfx', performance.now() - v0);
  // ?nanscan=1 — cheap watchdog for the "giant black triangle" class of
  // bug: a non-finite/insane vertex in ANY dynamic buffer rasterizes as
  // a fullscreen quad (undefined per spec), indistinguishable from a
  // bloom smear except that HUD/viewmodel survive. Scans scene buffers.
  if (NANSCAN) {
    nanScanTick(deps.sceneSetup.scene, deps.camera);
    if (!nanProbeBound) {
      nanProbeBound = true;
      nanScanBindProbe(() => ({ scene: deps.sceneSetup.scene, camera: deps.camera }));
    }
  }
  st.fxJobs.length = 0;
  st.fxJobs.push(
    ['effects', () => deps.lazyEffects().update(fxDt)],
    ['debris', () => updateDeadList(deps.world.debrisList, fxDt)],
    ['pdebris', () => {
      const list = deps.world.playerDebrisList;
      const cam = deps.camera.position;
      // A nearby mass kill otherwise turns this one job into a 7ms+
      // spike: past the cap, remaining debris take a ~zero deadline —
      // the same resumable slice path far debris already use.
      const t0 = performance.now();
      let i = list.length - 1;
      for (; i >= 0; i -= 1) {
        const d = list[i]!;
        const dx = d.ox - cam.x, dy = d.oy - cam.y, dz = d.oz - cam.z;
        if (dx * dx + dy * dy + dz * dz < VFX_NEAR_SQ) {
          // Resumable shard budget — one debris can't overdraw the cap.
          d.update(fxDt, 1.5 - (performance.now() - t0));
          if (performance.now() - t0 > 1.5) {i -= 1; break; }
        } else {d.update(fxDt, 0.15);} // far: resumable ~1-shard slice —
        // tickAge froze shards mid-air at spawn positions for their
        // whole 6-8s life (same parked-ring bug as Explosion.tickAge)
        if (d.dead) { d.dispose(); list.splice(i, 1); }
      }
      for (; i >= 0; i -= 1) {
        const d = list[i]!;
        d.update(fxDt, 0.05); // over-budget tail — one shard a frame still beats frozen chunks
        if (d.dead) { d.dispose(); list.splice(i, 1); }
      }
    }],
    ['gibs', () => updateGibs(fxDt)],
    ['swipes', () => updateSwings(fxDt, deps.camera)],
    ['scorch', () => {
      updateDeadList(deps.world.scorches, fxDt);
      updateDeadList(deps.world.splats, fxDt);
    }],
    ['explosions', () => {
      const ex = deps.world.explosions;
      for (let i = 0; i <= ex.length - MAX_LIVE_EXPLOSIONS; i += 1) {ex[i]!.dead = true;}
      // Same 260m rule as the vfx sim-pause — a blast past it is sub-pixel,
      // so it ages out without paying the layer/spark buffer writes.
      const cam = deps.camera.position;
      for (let i = ex.length - 1; i >= 0; i -= 1) {
        const e = ex[i]!;
        if (!e.dead) {
          if (e.pos.distanceToSquared(cam) < VFX_NEAR_SQ) {e.update(fxDt);}
          else {e.tickAge(fxDt);}
        }
        if (e.dead) { e.dispose(); ex.splice(i, 1); }
      }
    }],
    ['implosions', () => updateDeadList(deps.world.implosions, fxDt)],
    ['aoegiz', () => updateDeadList(deps.world.aoeGizmos, fxDt)],
  );
  if (st.fxCursor > 0) {st.fxJobs.push(...st.fxJobs.splice(0, st.fxCursor));}
  st.fxCursor = (st.fxCursor + 1) % st.fxJobs.length;
  budget.each('fxdecay', st.fxJobs, FX_MS_CAP, ([name, run]) => {
    const t0 = performance.now();
    run();
    fxJobSample(name, performance.now() - t0);
  });
  // Deferred lists resume on their own next frame — nothing carries over.
  st.fxJobs.length = 0;
}

/** Stage 3 — HUD + viewmodel + ambient/atmosphere, then render. */
function hudTick(deps: GameLoopDeps, st: LoopState, budget: ReturnType<typeof createFrameBudget>, perf: ReturnType<typeof createPerfHud>, f: TickFrame, fxDt: number): void {
  const { dt, player, networkManager, demoManager } = f;
  const { camera, sceneSetup, entities } = deps;
  const hud = deps.lazyHud();
  const viewModel = deps.lazyViewModel();
  const terrain = deps.lazyTerrain();

  hud.update(dt, player, networkManager.getPing(), networkManager.getPacketLoss(), networkManager.getJitter());
  hud.setConnDown(networkManager.connectionDown(), networkManager.connectionDownReason());
  const playerSheep = deps.lazyPlayerSheep?.();
  if (playerSheep) {
    playerSheep.tick(dt, player, terrain, deps.world.remotePlayers, deps.world.localTeam);
    hud.setSheep(playerSheep.shown);
    hud.setEnergy(playerSheep.energy);
  }
  hud.setGround(player.onGround, player.pos.y - terrain.getHeight(player.pos.x, player.pos.z));
  // Self blob — the first-person body never reaches the shadow pass, so
  // it joins the shared instanced blob pool remotes/creatures ride.
  const selfShadows = getShadows();
  if (selfShadows) {
    if (_selfShadowOwner.shadowSlot < 0) {_selfShadowOwner.shadowSlot = selfShadows.alloc(_selfShadowOwner);}
    if (_selfShadowOwner.shadowSlot >= 0) {
      const cap = classCapsule(player.appliedClass);
      _selfShadowPos.set(player.pos.x, player.pos.y - cap.eye, player.pos.z);
      selfShadows.set(_selfShadowOwner, _selfShadowPos, cap.radius * 1.9, 0.4);
    }
  }
  // Entity-count text is a slow-moving counter — 10Hz is plenty.
  budget.sweep('census', 100, () => hud.setEntityCounts(censusEntities(deps, entities)));
  // Belt charges ARE the nugget wallet — spawn stock + pickups, spent by
  // throws/deploys. (nuggetsCollected only counts pickups, so the HUD
  // read 0 at spawn even though the belt economy starts at BELT_MAX.)
  hud.setNuggets(player.beltCharges);
  // The run clock only ticks offline — show it only then, else it's a
  // frozen 00:00 under the FPS counter in every match.
  hud.setTimerVisible(!(demoManager?.isPlaying ?? false) && !networkManager.isConnected() && !CLASSIC_MODE);
  hud.setTimer(deps.waveDirector().elapsed);
  // Classic's Unity-style top-center readout owns the clock — the
  // corner timer hides so they don't double up.
  hud.setClassicScore(CLASSIC_MODE
    ? { score: player.score, kills: player.kills, seconds: deps.waveDirector().elapsed }
    : null);
  hud.setMatchStatus(
    deps.world.matchEndsAt ? deps.world.matchEndsAt - Date.now() : null,
    deps.world.flagStates,
  );
  hud.updateDeathCountdown(deps.world.respawnMs, player.respawnHeld);
  // Every frame — a rotating radar at the 25Hz sweep cadence reads as
  // visibly choppy next to the 60fps world, and the redraw is ~30 arcs.
  deps.ambientBirds.positions(_birdPosBuf);
  // Player/bot blips — same friend-or-foe rule as the overhead markers:
  // wire team (or GameBot.team) matching localTeam = green, else red.
  // Dead and cloaked riders are dropped — no corpse pings, no cloak leak.
  const wirePlayers = networkManager.getPlayers();
  let blipN = 0;
  deps.world.remotePlayers.forEach((rp, id) => {
    // A fire-revealed cloak (ghostT live) blips like any visible rider —
    // the shimmer window already sold him out to eyes and HUD.
    if (rp.isDead || (rp.isCloakHidden && rp.ghostT <= 0)) {return;}
    const team = (rp as { team?: string }).team ?? wirePlayers.get(id)?.team;
    // Reused buffer — a fresh object per remote per frame was ~1.2k
    // throwaway blips/s of pure GC churn.
    let b = _mapBlips[blipN];
    if (!b) { b = { x: 0, z: 0, friendly: false, bot: false }; _mapBlips.push(b); }
    b.x = rp.position.x; b.z = rp.position.z;
    b.friendly = Boolean(team) && team === deps.world.localTeam; b.bot = isBotId(id);
blipN += 1;
  });
  _mapBlips.length = blipN;
  hud.updateMinimap(entities.targets, entities.nuggets, player.pos, player.yaw, _birdPosBuf, _mapBlips);
  if (hud.commandMapOpen) {hud.updateCommandMap(player.pos, player.yaw, _mapBlips, deps.world.flagMarkers);}

  // During demo playback the vm mirrors the frame's recorded weaponType —
  // hiding it would strip the shooter POV from cool-shot clips.
  // The middle-click orbit cam IS a third-person view while it's on —
  // hiding the FP gun is what stops "your own gun plus your own model".
  viewModel.group.visible = !player.isDead && !player.thirdPerson && !player.isSpectating && !player.input.midHeld;
  const yawDelta = Math.atan2(Math.sin(player.yaw - st.lastYaw), Math.cos(player.yaw - st.lastYaw));
  // Paused demo = frozen world — the vm's idle sway/bob reads as the scene
  // still playing. dt=0 freezes the anims; the weapon itself stays bound
  // to the recorded frame's weaponType via onPlaybackState.
  viewModel.update(demoManager?.isPaused ? 0 : dt, yawDelta, player.pitch - st.lastPitch, player.vel, camera, player.shootAnimTimer > 0);
  st.lastYaw = player.yaw;
  st.lastPitch = player.pitch;
  perf.mark('viewmodel');
  deps.lazyHealthBarSystem().update(dt, networkManager.getPlayers(), deps.world.remotePlayers, entities.balls, deps.world.localTeam);
  perf.mark('healthbars');

  // Peripheral speed lines along the true velocity vector; demo-suppressed.
  deps.speedLines.update(fxDt, camera.position, demoManager?.isPlaying ? _zeroVel : player.vel);

  if (st.cpuLevel === 0) {
    for (const layer of deps.ambientLayers) {layer.update(fxDt, camera.position, terrain);}
    deps.groundMist().update(fxDt, camera.position);
    deps.ambientBirds.update(fxDt, player.pos, terrain, player.isDead);
  }
  perf.mark('ambient');

  sceneSetup.update(dt);
  sceneSetup.atmosphericSky.followCamera(camera.position);
  sceneSetup.updateCamera(camera);

  // Shake composes after player.update's camera write; the LG beam weld
  // is last — it needs the swayed viewmodel AND the post-shake camera or
  // fast moves leave the bolt a frame stale.
  screenShake.update(dt, camera);
  deps.combat()?.updateBeamVisual();
  sfxAudio.updateAudio(dt, player, camera);
  perf.mark('scene');
}


// stats.js perf panels — FPS/MS/MB in a row along the bottom-right,
// toggled with ` (backquote). stats.js only renders one panel per
// instance, so use one per metric; panels are 80px wide + 8px gap.
function makeStatsPanels(): Stats[] {
  return [0, 1, 2].map((panel, i) => {
    const s = new Stats();
    s.showPanel(panel);
    const dom = s.dom as HTMLElement;
    dom.id = `stats-${i}`;
    // bottom:40 — above the "⟳ files changed" badge strip (bottom:8, ~24px tall)
    // --z-br-3: reserved debug row in hud.css — hardcoding an offset here
    // is what parked the charts on top of the entity-counts row.
    dom.style.cssText = `position:fixed;bottom:var(--z-br-3);right:${20 + (2 - i) * 88}px;left:auto;top:auto;z-index:10000;display:none;`;
    document.body.append(dom);
    return s;
  });
}

function wireDebugKeys(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, budget: ReturnType<typeof createFrameBudget>, statsPanels: ReturnType<typeof makeStatsPanels>): void {
  // window.__perf — live phase table for headless probes + manual reads;
  // the watchdog dump uses the same data for shipped logs.
  window.__perf =
    () => ({ ...perf.snapshot(), gpu: gpuMs(), ...budget.stats() as unknown as Record<string, number>, ...fxJobStats(),
      // info reset lives in perf.begin — counters span every pass of the
      // previous frame (scene+shadow+composer+viewmodel), not just the last.
      draws: deps.rendererSetup.renderer.info.render.calls,
      trisK: Number((deps.rendererSetup.renderer.info.render.triangles / 1000).toFixed(0)) });
  // Debug-only handles (__renderScan/__scene/__renderer, geoNaN watch)
  // stay off prod — __perf/__trailDump/__renderDump stay since the shipped
  // watchdog dump reads them.
  if (isDevHost()) {
    // window.__renderScan — staged render breakdown (scene / +shadow / full
    // pipeline / viewmodel) with per-stage calls+tris+GPU-ms. Profiling
    // hook; renders extra frames on top of the loop.
    window.__renderScan = createRenderScan(deps);
    // __scene/__renderer — profiling handles for headless probes
    // (per-class triangle census, ad-hoc visibility A/Bs). Debug-only.
    window.__scene = deps.sceneSetup.scene;
    window.__renderer = deps.rendererSetup.renderer;
    // geoNaN watch — names the owner of any buffer whose bounding sphere
    // computes NaN (the spam was ownerless before this probe existed).
    installGeoNaNWatch(deps.sceneSetup.scene);
  }
  // __trailDump — merged census of every self-registered FX diag section
  // (ribbons/vfx/inst/swarm…). Sections come from registerDiag() in the
  // owning modules, so new censuses never touch this wiring.
  window.__trailDump = collectDiag;
  document.addEventListener('keydown', (e) => {
    // Alt+W — bot weapon audit: last gun each bot drew + its shot count,
    // so "do they fire real weapons" is a one-keypress read. Alt+Shift+W
    // keeps the old hard-reload hatch (F5 is flaky under pointer lock).
    if (e.altKey && e.code === 'KeyW') {
      e.preventDefault();
      if (e.shiftKey) { window.location.reload(); return; }
      const rows = [...lastWeaponByPlayer.entries()]
        .filter(([id]) => isBotId(id))
        .map(([id, r]) => `${id} ${WeaponType[r.wt] ?? `w${r.wt}`} shots=${r.n}`);
      Logger.info(rows.length > 0 ? `[botweapons] ${rows.join(' | ')}` : '[botweapons] no bot fire seen yet');
      return;
    }
    if (e.code === 'Backquote') {
      e.preventDefault();
      const show = (statsPanels[0]!.dom as HTMLElement).style.display === 'none';
      for (const s of statsPanels) {
        (s.dom as HTMLElement).style.display = show ? 'block' : 'none';
      }
      perf.setVisible(show);
      // Bottom-right entity census is debug data too — same toggle.
      deps.lazyHud().setEntCountsVisible(show);
      // The log mirror rides the same debug view.
      setLogOverlayVisible(show);
      // Sheep meters over remote heads are debug data too — the
      // standing badge is HP without the overlay.
      setDebugOverlays(show);
      // Debug chrome changes the corner stack — audit for collisions the
      // frame after the layout settles.
      if (show) {requestAnimationFrame(() => requestAnimationFrame(reportHudOverlap));}
    }
  });
}

// Interior shadow casters distance-gated like remotes: only near-camera
// architecture darkens the map; far towers' shadows are unreadable.
// Census showed ~700 caster meshes — at a base view they were half the
// shadow pass's draw calls.
function gateInteriorCasters(deps: GameLoopDeps, st: LoopState, camera: THREE.Camera): void {
  const epoch = getInteriorsEpoch();
  if (st.interiorEpoch !== epoch) {
    st.interiorEpoch = epoch;
    st.interiorCasters = undefined;
    const g = deps.sceneSetup.scene.getObjectByName('__t2interiors');
    if (g) {st.interiorCasters = g.children as THREE.Mesh[];}
  }
  if (!st.interiorCasters) {return;}
  for (const m of st.interiorCasters) {
    const bs = m.geometry.boundingSphere!;
    m.castShadow = (m.userData.castR as number) > 0 &&
      bs.center.distanceToSquared(camera.position) < (90 + bs.radius) ** 2;
  }
}

// Shader warmup — programs used to compile lazily mid-frame and hitch the
// first ~10s after join (render 116-134ms measured). Once the world content
// has landed, compileAsync parallel-compiles every scene material instead
// of stalling individual draws. Post-warmup stragglers (a remote's rig
// lands after join) get the same pass debounced — a profile of a live
// fight showed per-program onFirstUse validation burning ~10% of the
// frame while new materials trickled in.
function maybeWarmShaders(deps: GameLoopDeps, st: LoopState): void {
  if (st.warmed) {
    const rewarm = st.rewarmT ?? 0;
    if (rewarm > 0) {
      st.rewarmT = rewarm - 1;
      if (st.rewarmT === 0) {deps.rendererSetup.warmup();}
    }
    const count = deps.world.remotePlayers.size;
    if (count !== (st.lastRemoteCount ?? 0)) {st.lastRemoteCount = count; st.rewarmT = 90;}
    return;
  }
  if (++st.warmN <= 60) {return;}
  // getObjectByName walks the whole scene — poll every 30 ticks instead of
  // per frame while interiors land (a live profile caught the scan at ~2%
  // of a match profile through getObjectByProperty).
  if (st.warmN <= 600 && (st.warmN % 30 !== 0 || !deps.sceneSetup.scene.getObjectByName('__t2interiors'))) {return;}
  st.warmed = true;
  deps.rendererSetup.warmup();
  // One underground blast fills the burst-spec freelists, so the first
  // real explosion restarts pooled systems instead of paying cold
  // ParticleSystem builds mid-fight. 500m down it never renders.
  deps.world.explosions.push(new Explosion(deps.sceneSetup.scene, _prewarmPos, false, 0, deps.lazyTerrain(), 1));
}

const _prewarmPos = new THREE.Vector3(0, -500, 0);

// FPS cap: skip only the render call — sim/input stay full-rate.
// Carry leftover time so the cap hits its target rate, not stutters.
function fpsCapAllows(st: LoopState, rawElapsed: number): boolean {
  const cap = settings.get('fps-cap');
  if (cap <= 0) {return true;}
  st.renderAcc += rawElapsed;
  if (st.renderAcc < 1 / cap) {return false;}
  st.renderAcc = Math.min(st.renderAcc - 1 / cap, 1 / cap);
  return true;
}

export function createGameLoop(deps: GameLoopDeps) {
  let lastTime = 0;
  let renderElapsed = 0;
  const st: LoopState = { lastYaw: 0, lastPitch: 0, lowFpsFrames: 0, lowFpsAccum: 0, lastFpsDump: 0, gpuLevel: 0, cpuLevel: 0, cpuBound: false, headroomAccum: 0, autoPixel: false, fxCursor: 0, fxJobs: [], shadowAcc: 0, renderAcc: 0, warmN: 0, warmed: false, veilStable: 0, veilFrames: 0, bootStable: 0, bootFrames: 0, bootStableResolvers: [] };

  // stats.js perf panels — FPS/MS/MB in a row along the bottom-right,
  // toggled with ` (backquote). stats.js only renders one panel per
  // instance, so use one per metric; panels are 80px wide + 8px gap.
  const statsPanels = makeStatsPanels();
  const perf = createPerfHud();
  // AUTO QUALITY toggle (top of SETTINGS): off freezes the ladder where it
  // is AND restores full quality, so the user isn't left on a preset they
  // never picked. No reload — ladders gate on the setting live.
  const autoqBtn = document.querySelector('#autoq-toggle') as HTMLButtonElement | null;
  if (autoqBtn) {
    const label = () => { autoqBtn.classList.toggle('on', Boolean(settings.get('fps-autoq'))); };
    label();
    autoqBtn.addEventListener('click', () => {
      const on = !settings.get('fps-autoq');
      settings.set('fps-autoq', on);
      if (!on) {resetAutoQuality(deps, st);}
      label();
    });
  }
  // FPS CAP — render skip only; sim/input keep full rAF rate. A real
  // vsync-off isn't possible in a browser, but capping buys battery on
  // chromebooks and headroom measurement on high-refresh displays.
  const FPS_CAPS = [0, 30, 60, 120];
  const capBtn = document.querySelector('#fpscap-toggle') as HTMLButtonElement | null;
  if (capBtn) {
    const label = () => { const c = settings.get('fps-cap'); capBtn.textContent = c > 0 ? `FPS CAP: ${c}` : 'FPS CAP: OFF'; };
    label();
    capBtn.addEventListener('click', () => {
      const i = FPS_CAPS.indexOf(settings.get('fps-cap'));
      settings.set('fps-cap', FPS_CAPS[(i + 1) % FPS_CAPS.length]!);
      st.renderAcc = 0;
      label();
    });
  }
  // Frame-budget runner — ms-quota chunking + phased sweeps for work
  // that's expensive but not frame-critical. First pilot: the minimap
  // sweep at 25Hz (full-rate blip redraw was invisible anyway).
  const budget = createFrameBudget();
  wireDebugKeys(deps, perf, budget, statsPanels);

  function loop(time: number): void {
    requestAnimationFrame(loop);
    const rawElapsed = (time - lastTime) / 1000;
    const dt = Math.min(Number.isFinite(rawElapsed) ? Math.max(rawElapsed, 0) : 0, MAX_DELTA_TIME);
    if (Number.isFinite(time)) {lastTime = time;}
    fpsWatchdog(deps, st, budget, perf, rawElapsed, time);
    // Veiled = waiting on gameState — don't sim or take input, but DO
    // render: shader/pipeline warmup needs real draws or it fires on
    // the player's first interactive frame. The veil drops once state
    // landed AND ~45 stable frames ran (180-frame cap = safety valve).
    // Boot warmup counter runs even while veiled — the veil block counts
    // its own renders separately; here we meter real frames.
st.bootFrames += 1;
    if (rawElapsed < 0.026) {st.bootStable += 1; } else { st.bootStable = 0; }
    if (st.bootStableResolvers.length > 0 && (st.bootStable >= 45 || st.bootFrames >= 240)) {
      const resolvers = st.bootStableResolvers;
      st.bootStableResolvers = [];
      for (const r of resolvers) { r(); }
    }
    if (isSessionVeiled()) {
      deps.rendererSetup.renderer.render(deps.sceneSetup.scene, deps.camera);
st.veilFrames += 1;
      if (rawElapsed < 0.026) {st.veilStable += 1; } else { st.veilStable = 0; }
      if (isSessionVeilReady() && (st.veilStable >= 45 || st.veilFrames >= 180)) {
        st.veilStable = 0;
        st.veilFrames = 0;
        dropSessionVeil();
      }
      return;
    }
    perf.begin(deps.rendererSetup.renderer);

    // Hidden tabs get ~1 rAF/sec — dt clamps to 0.05 so game logic runs in
    // slow motion, but cosmetic VFX must still expire in real time or they
    // stack into an overdraw bomb while you're AFK. fxDt = wall-clock
    // (clamped 2s) when hidden; normal dt when visible.
    const fxDt = document.hidden ? Math.min(rawElapsed, 2) : dt;

    const player = deps.lazyPlayer();
    const terrain = deps.lazyTerrain();
    const networkManager = deps.lazyNetworkManager();
    const demoManager = deps.lazyDemoManager();

    const frame: TickFrame = { dt, player, networkManager, demoManager };
    // Late-bound once: the ops uplink reads the perf EMA (JS frame cost +
    // real present rate) but perf doesn't exist until the loop starts.
    if (!networkManager.statsSource) {
      networkManager.statsSource = () => {
        const s = perf.snapshot();
        // Per-victim render delay map — rewinding every victim by the
        // MAX delay validates ~500ms behind a fast ghost the shooter is
        // actually tracking at ~100ms: the classic "numbers, no damage".
        // renderLagMs stays as the fallback for old wires/creatures.
        let renderLagMs = 0;
        const renderLag: Record<string, number> = {};
        deps.world.remotePlayers.forEach((rp, id) => {
          renderLag[id] = rp.renderDelayMs;
          if (rp.renderDelayMs > renderLagMs) {renderLagMs = rp.renderDelayMs;}
        });
        return { fps: s.frame > 0 ? Math.round(1000 / s.frame) : 0, jsMs: s.frame, renderLagMs, renderLag };
      };
    }
    const demoPaused = simTick(deps, perf, frame, terrain);
    if (!demoPaused) {fxTick(deps, st, budget, fxDt);}
    perf.mark('fx');
    deps.remotes().updateScoreboard();

    // ?dummy debug remote — pin it in front of the camera and tick it
    const dummy = deps.world.remotePlayers.get('dummy');
    const dummyTick = deps.getDummyTick();
    if (dummyTick) { dummyTick(dt); if (dummy) {dummy.tick(dt);} }

    hudTick(deps, st, budget, perf, frame, fxDt);
    perf.mark('hud');

    renderElapsed += rawElapsed; // real time between presents for the FPS meter
    if (fpsCapAllows(st, rawElapsed)) {
      deps.lazyHud().markFrame(renderElapsed);
      // stats.js panels count update() calls as frames — update only on
      // real renders or the FPS panel reads the rAF rate under a cap.
      // (Still gated on display — they paint even while hidden.)
      if ((statsPanels[0]!.dom as HTMLElement).style.display !== 'none')
        {for (const s of statsPanels) {s.update();}}
      renderElapsed = 0;
      renderFrame(fxDt); // damage numbers ride fxDt — same hidden-tab decay fix
    }
    perf.mark('render');
    perf.end(deps.rendererSetup.renderer, () => {
      const bw = deps.lazyNetworkManager().bandwidth();
      return `tgt ${deps.entities.targets.length} rem ${deps.world.remotePlayers.size}\n` +
        `net ↑${fmtBps(bw.up)} ↓${fmtBps(bw.down)}`;
    });
  }

  function renderFrame(dt: number): void {
    const { camera, rendererSetup, sceneSetup } = deps;
    // FLOYD overlay hook — idempotent; the VM draw runs inside fsRender so
    // the gun lands in the readPixels buffer and gets dithered too.
    rendererSetup.setOverlayPass(() => {
      const vm = deps.lazyViewModel(), vmc = deps.vmCamera();
      if (!vm.group.visible) {return;}
      vmc.aspect = camera.aspect;
      vmc.updateProjectionMatrix();
      vmc.quaternion.copy(camera.quaternion);
      const prev = rendererSetup.renderer.autoClear;
      rendererSetup.renderer.autoClear = false;
      rendererSetup.renderer.clearDepth();
      rendererSetup.renderer.render(deps.vmScene(), vmc);
      rendererSetup.renderer.autoClear = prev;
    });
    const viewModel = deps.lazyViewModel();
    const vmCamera = deps.vmCamera();
    const vmScene = deps.vmScene();
    const {renderer} = rendererSetup;

    gateInteriorCasters(deps, st, camera);
    maybeWarmShaders(deps, st);

    // Shadow-map throttle under the auto-quality ladder: a full-scene
    // re-raster every frame is the heaviest single GPU cost. At ladder ≥2
    // the map only re-renders every 2nd frame (≥4 every 3rd) — casters move
    // fast enough for a frame or two of lag to be invisible.
    const shadow = renderer.shadowMap;
    if (shadow.enabled) {
      const period = st.gpuLevel >= 4 ? 3 : 2;
      shadow.autoUpdate = false;
      if (++st.shadowAcc >= period) { st.shadowAcc = 0; shadow.needsUpdate = true; }
    } else {
      shadow.autoUpdate = true;
      st.shadowAcc = 0;
    }

    gpuBegin(renderer);
    if (rendererSetup.needsComposer()) {
      rendererSetup.render(dt); // FLOYD: overlay pass (the VM draw below) runs inside
    } else {
      renderer.render(sceneSetup.scene, camera);
    }

    // Viewmodel pass — clear depth only, draw gun on top with its own FOV.
    // Only needed on the direct-render path: FLOYD injects the same draw
    // into fsRender pre-readback, and composer modes (xBR/dithered/bloom)
    // now draw it inside the frame buffer via VmRenderPass — skipping
    // here keeps the gun inside the pixel/dither pipeline, not pasted
    // full-res over a chunky frame.
    if (viewModel.group.visible && !rendererSetup.isFloyd() && !rendererSetup.needsComposer()) {
      vmCamera.aspect = camera.aspect;
      vmCamera.updateProjectionMatrix();
      vmCamera.quaternion.copy(camera.quaternion);
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(vmScene, vmCamera);
      renderer.autoClear = prevAutoClear;
    }
    gpuEnd();

    // Staged video export: captureStream reads a blank GL buffer unless
    // preserveDrawingBuffer is on — the blit must ride this same rAF.
    deps.lazyDemoManager()?.video.pump();

    // Damage numbers update after post-processing (bypass bloom/contrast for visibility)
    deps.damageNumberManager().update(dt, deps.camera);
  }

  return {
    start(): void { requestAnimationFrame(loop); },
    /** Resolves once ~45 consecutive sub-26ms frames rendered (or ~4s
     *  of frames pass on a weak box — never gates forever). Offline
     *  starts wait on this so the match doesn't spawn mid-compile-hitch. */
    whenStable(): Promise<void> {
      if (st.bootStable >= 45) { return Promise.resolve(); }
      return new Promise((resolve) => { st.bootStableResolvers.push(resolve); });
    },
  };
}
