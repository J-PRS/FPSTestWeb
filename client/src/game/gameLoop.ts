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
import type { AmbientWeather } from '../effects/ambientWeather.js';
import type { GroundMist } from '../effects/groundMist.js';
import type { AmbientBirds } from '../effects/birds.js';
import { screenShake } from '../effects/screenShake.js';
import { Explosion } from '../effects/explosion.js';
import { updateVfx } from '../effects/vfx.js';
import { collectDiag } from '../core/fxDiag.js';
import { telemetry, recDrift } from '../core/telemetry.js';
// oxlint-disable-next-line import/no-unassigned-import
// oxlint-disable-next-line import/no-unassigned-import
import '../core/visAudit.js'; // side-effect: registers the Alt+Q visAudit section
import { setLogOverlayVisible } from '../ui/logPanel.js';
import { setDebugOverlays } from '../ui/hud/indicators.js';
import { setBootVeil } from '../ui/hud/hudChrome.js';
import { reportHudOverlap } from '../ui/overlapAudit.js';
import { installGeoNaNWatch } from '../core/geoNaN.js';
import * as sfxAudio from '../core/sfx/world.js';

import type { NetworkManager } from '../networking/NetworkManager.js';
import type { HUD } from '../ui/hud.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { createScene } from '../world/scene.js';
import { fogHorizon, syncFxFog } from '../world/directionalFog.js';
import { updateCubeSky, getInteriorsEpoch, isTerrainSwapPending } from './net/mapAssets.js';
import { isSessionVeiled, dropSessionVeil, isSessionVeilReady, isSessionSeated } from './net/world.js';
import { tickUnderwaterGrade } from '../world/waterSurface.js';
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
import { parityMiss, kbEchoHorizon, kbStampDeadline } from './parity.js';
import { fpsWatchdog, resetAutoQuality, fxJobSample, fxJobStats, seedGpuTier, setShadows } from './loopPerf.js';
import { createRenderScan } from './renderScan.js';
import { settings } from '../core/settings.js';
import { WeaponType } from '../../../shared/weapons.js';
import { classCapsule, classMass } from '../../../shared/botClasses.js';
import type { BodyCapsule } from '../../../shared/movement.js';
import { isBotId } from '../../../shared/botNames.js';
import { nanScanTick, nanScanBindProbe } from '../core/nanScan.js';
import { Logger } from '../core/Logger.js';
import type { PlayerSheep } from './playerSheep.js';
import { BootWarmup, pendingHeavy } from './bootWarmup.js';
import { warmRig } from '../entities/rigPool.js';
import { PlayerModel } from '../entities/PlayerModel.js';

const _zeroVel = new THREE.Vector3(); // shared zero for demo playback
// Frame-jump forensic: compare pos at the same point each frame so any
// discontinuity - respawn, correction, teleport - lands in the log with
// its from→to pair. Honest skiing is ~2-4m/frame even at 30fps; 8m only
// fires on a real snap.
const _posPrev = new THREE.Vector3();
import { isPosPrimed, setPosPrimed, noteLocalSnap } from './posPrimed.js';
import { hudRegion } from '../ui/hud/regions.js';

/** Authoritative reseats (respawn, correction, gameState restore, journal
 *  rewind) teleport the body by design - the frame-jump watch must not
 *  read them as physics snaps. Snap paths call this after pos.set. */
// noteLocalSnap + _posPrimed state live in posPrimed.ts (shared with
// world.ts to avoid a value cycle). Re-export for callers that still
// import it from gameLoop.
export { noteLocalSnap } from './posPrimed.js';
const JUMP_FRAME_M = 8;
// Knocked/skied hard enough to teleport = real teleport class, but a jet
// burst + downhill ski can legitimately clear 8m mid-frame - spam once/s
// max, the jump itself still counts every time via _posPrev tracking.
let _posJumpLastAt = 0;
const _birdPosBuf: THREE.Vector3[] = []; // scratch - minimap debug blips
const _selfShadowOwner = { swarmSlot: -1, shadowSlot: -1 }; // self blob - shared instanced pool slot
const _selfShadowPos = new THREE.Vector3();
const _mapBlips: MinimapPlayer[] = []; // scratch - minimap player/bot blips
const _driftVec = new THREE.Vector3(); // scratch - drift sampler's projected wire pos
let lastDriftMs = 0;

// ?mode=classic - solo bounce-and-shoot: balls only, no rage, no roster
const CLASSIC_MODE = urlParams.isClassic;
// ?nanscan=1 - see fxTick; hunts the screen-covering-triangle flash.
const NANSCAN = urlParams.get('nanscan') === '1';
let nanProbeBound = false;

// Dead-checkable effect list - update each, dispose+splice the finished.
function updateDeadList<T extends { update(dt: number): void; dead: boolean; dispose(): void }>(list: T[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    list[i]?.update(dt);
    if (list[i]?.dead) { list[i]?.dispose(); list.splice(i, 1); }
  }
}

const _aliveCount = (l: { dead: boolean }[]): number => { let n = 0; for (const e of l) {if (!e.dead) {n += 1;}} return n; };

// Live-explosion ceiling - a busy room stacks blasts until particles
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
  weather: AmbientWeather;
  groundMist: () => GroundMist;
  ambientBirds: AmbientBirds;
  entities: ReturnType<typeof createEntities>;
  combat: () => ReturnType<typeof createCombat>;
  remotes: () => ReturnType<typeof createRemotes>;
  demoLifecycle: () => ReturnType<typeof createDemoLifecycle>;
  waveDirector: () => ReturnType<typeof createWaveDirector>;
  /** ?mode=nuggets - Nugget Wars bot manager; null otherwise. */
  teamBots?: () => { update(dt: number): void } | null;
  world: WorldState;
  // ?dummy debug hook - null when the param isn't set
  getDummyTick: () => ((dt: number) => void) | null;
  /** Local sheep meter - ticks each frame from hudTick so the crosshair
   *  readout and scoreboard self-row share the smoothed value. */
  lazyPlayerSheep?: () => PlayerSheep;
}

// The frame loop + render pass. Everything mutable it touches comes in via
// deps so main.ts stays a pure wiring file.
export interface LoopState {
  lastYaw: number;
  lastPitch: number;
  lowFpsFrames: number;
  lowFpsAccum: number;
  lastFpsDump: number;
  /** Dynamic quality levels - render cost (0=full … 5=cheapest) and CPU
   *  cost (0=all ambient work … 2=stripped). Chosen per dump by whether
   *  JS phases or raster dominated the slow frames: a CPU-throttled box
   *  gains nothing from a smaller framebuffer. */
  gpuLevel: number;
  cpuLevel: number;
  cpuBound: boolean;
  /** Wall-clock accumulator of >55fps frames - step-up hysteresis so a
   *  brief smooth burst doesn't bounce quality up and down. */
  headroomAccum: number;
  /** True when the current pixel mode was set by auto-scaling, not the
   *  user - auto-set modes must not read as a pinned user choice. */
  autoPixel: boolean;
  fxCursor: number;
  fxJobs: [name: string, run: () => void][];
  /** Shadow-map throttle accumulator - see renderFrame. */
  shadowAcc: number;
  /** FPS-cap render skip accumulator - see loop. */
  renderAcc: number;
  /** Auto-quality's runtime render cap at the deepest CPU tier - an
   *  explicit fps-cap always wins; null = no auto cap. */
  autoCap: number | null;
  /** Cached interior meshes for the per-frame shadow-caster distance
   *  gate - populated once the __t2interiors group exists, and re-
   *  censused whenever applyInteriors swaps it (map change disposes
   *  the old meshes; a stale cache would gate corpses forever). */
  interiorCasters?: THREE.Mesh[];
  interiorEpoch?: number;
  /** Frames rendered before the shader warmup fires - lets async content
   *  (interiors, rigs) land in the scene before compileAsync runs. */
  warmN: number;
  warmed: boolean;
  /** Terrain materials compiled once after the real terrain lands (under
   *  the veil) so stragglers don't hitch the live-under-veil frames. */
  terrainCompiled?: boolean;
  /** Post-warmup recompile countdown - arms when the remote roster
   *  changes so late-loading rigs still get a parallel compile pass
   *  instead of hitching their first visible frame. */
  rewarmT?: number;
  lastRemoteCount?: number;
  /** Veil warmup - sub-26ms frames rendered behind the session veil.
   *  The veil drops only once gameState landed AND frames are stable,
   *  so first-draw compiles/uploads happen off the player's clock. */
  veilStable: number;
  veilFrames: number;
  /** Live-under-veil: the full loop runs behind the overlay once the
   *  seat is placed; the drop counts stable REAL frames. */
  veilLive: boolean;
  veilLiveFrames: number;
  /** We froze input for the veil (unfreeze only what we froze). */
  veilFroze: boolean;
  /** Boot warmup - same stability signal as the veil, but for the
   *  un-veiled start: offline modes gate their spawn/roster kick-off on
   *  whenStable() so the game doesn't begin mid-hitch. */
  bootWarmup: BootWarmup;
  /** HUD is hidden while the boot hold runs - transition-tracked so the
   *  release show() can't stomp a hide() someone else owns. */
  hudHeld?: boolean;
}

// fxJob EMA/max bookkeeping lives in loopPerf - see fxJobSample there.

// Demo bookkeeping: update recorder/player, freeze input during playback.
// Returns whether demo playback is currently paused. Only unfreezes what
// tickDemo froze - the boot warmup gate holds the lock independently.
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

// Offline boot hold: while warmup hasn't released (or the input freeze it
// raised is still on), render the world but keep the match out of play -
// entities don't tick and the viewmodel stays hidden. Online rooms and
// demo playback are never held: the server doesn't wait for our shaders.
function bootHoldActive(f: TickFrame): boolean {
  return !f.demoManager?.isPlaying && !f.networkManager.isConnected()
    && (!f.bootReleased || f.player.inputFrozen);
}

// Species census for the bottom-left debug readout - in-place count,
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

// Fog uniforms ride the terrain shader - must sync every frame. The fog
// color is CONSTANT across the whole view: the terrain haze and the sky
// dome's ground/horizon band must share one color, or a fully-fogged ridge
// won't dissolve into the sky. That seamless terrain→skybox blend is the
// whole point of the haze (T1/T2 dune maps). Directional sun warmth belongs
// in the sky's Mie glow, NOT a flat fog tint whose color would swing with
// the camera and break the seam.
function syncFog(deps: GameLoopDeps, terrain: Terrain): void {
  const {fog} = deps.sceneSetup.scene;
  if (!(fog instanceof THREE.Fog)) {return;}
  const fogCol = fog.color; // constant authored/engine haze (see applyMapFog)
  deps.sceneSetup.atmosphericSky.setFogColor(fogCol);
  deps.sceneSetup.atmosphericSky.setHorizonColor(fogHorizon() ?? fogCol);
  updateCubeSky(deps.camera, fogCol);
  refreshColliderGizmoVisibility();
  // F1 terrain overlay - cyan wire on the drawn clipmap, yellow wire
  // patch on the collider lattice around the player.
  const pp = deps.lazyPlayer().pos;
  terrain.setDebugWire(urlParams.debug, pp.x, pp.z);
  terrain.updateFog(fog.color, fog.near, fog.far);
  syncFxFog(fog); // world-space ShaderMaterials share the same range
}

/** Contact bodies the local player's prediction resolves against -
 *  refilled each frame so the sim matches the server's shadow. */
const _contactBodies: BodyCapsule[] = [];

/** Stage 1 - world sim: player, terrain, entities, wave director,
 *  projectiles. Returns demoPaused for the later stages. */
interface TickFrame { dt: number; rawDt: number; player: Player; networkManager: NetworkManager; demoManager: DemoManager | null; bootReleased: boolean }
const fmtBps = (b: number): string => {
  if (b >= 1_048_576) {return `${(b / 1_048_576).toFixed(1)}MB/s`;}
  if (b >= 1024) {return `${(b / 1024).toFixed(1)}KB/s`;}
  return `${Math.round(b)}B/s`;
};

function tickEntities(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, dt: number, demoPlaying: boolean, bootReleased: boolean, rawDt = dt): void {
  const {entities} = deps;
  entities.updateBalls(dt);
  perf.mark('balls');
  // ?mode=classic - balls are the whole roster, every other species'
  // tick is skipped (they self-spawn ambiently, so ticking = populating)
  if (!CLASSIC_MODE) {
    entities.updateSpeciesAll(dt);
    entities.updateDeployables(dt);
  }
  perf.mark('species');
  // Ambient population is an offline feature - connected rooms own
  // their balls/creatures on the wire; the director spawning locals
  // alongside them was the busy double-population on join.
  // The director's clock is the visible match timer - gating on the
  // same release that unfreezes the player keeps 'spawned' and 'clock
  // started' as one event instead of a timer running behind the veil.
  if (!demoPlaying && !deps.lazyNetworkManager().isConnected() && bootReleased) {deps.waveDirector().update(dt);}
  if (!demoPlaying) {entities.updateNuggets(dt);}
  deps.teamBots?.()?.update(dt);
  // Solo conquest lattice - offline only; connected rooms get nodeUpdate
  // on the wire and this field stays unset.
  deps.world.soloConquest?.tick(dt);
  // Crystal idle motion - rosters arrive a few times a second, the
  // affordance animates between them.
  deps.world.nodeLayer?.tick(dt, performance.now());
  perf.mark('bots');
  if (!demoPlaying) {deps.combat()?.updateProjectiles(dt, rawDt);}
  // Offline clip render steps this with demo-dt per output frame -
  // a wall-dt tick here would make shells fly at render speed.
  if (!deps.lazyDemoManager()?.offlineRender) {deps.demoLifecycle().updatePlaybackProjectiles(dt);}
  perf.mark('proj');
}


function simTick(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, f: TickFrame, terrain: Terrain): boolean {
  const {bootReleased} = f;
  const { dt, player, demoManager, networkManager } = f;
  // Offline pause: a hidden tab rAFs ~1/s, so the local match would crawl
  // at 5% speed and bots keep slowly fighting - a real pause matches user
  // intent. Online rooms must keep simulating: the server doesn't stop.
  if (document.hidden && !networkManager.isConnected()) {return false;}
  // Player-vs-player contact: remotes + lobby bots all live in this set -
  // corpses don't block. Interpolated positions are a half-RTT stale but
  // the push only has to agree with the shadow's, not be perfect.
  let bodyN = 0;
  for (const rp of deps.world.remotePlayers.values()) {
    if (rp.isDead) {continue;}
    // Reused pool - fresh 7-field structs per remote per frame were
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
  // kb-echo stamp expiry is time-owned, not event-owned: blastForce and
  // the knockback handler only sweep inside their own events, so a
  // rejected predicted shove sat unexpired until the next blast - and
  // misreported its rejection age (up to ~20s) when it finally landed.
  const kbStamps = deps.world.selfBlastStamps;
  if (kbStamps.length > 0) {
    // Death voids pending stamps - the respawn teleports the body, so any
    // verdict arriving now was judged at the corpse's ghost, not ours.
    if (deps.lazyPlayer().isDead) {kbStamps.length = 0;}
    const now = performance.now();
    // Starvation-tolerant: an inbound silence delays every echo - a stamp
    // younger than horizon+silence can't have been refused yet (the same
    // horizon the knockback handler + blastForce sweeps share).
    const kbnm = deps.lazyNetworkManager();
    const kbHorizon = kbEchoHorizon(kbnm.serverPingMs ?? kbnm.getPing(), kbnm.msSinceLiveRx());
    for (let i = kbStamps.length - 1; i >= 0; i -= 1) {
      const s = kbStamps[i]!;
      if (now > kbStampDeadline(s, kbHorizon)) {
        // Self-authored stamps are confirmation-free by design (server
        // skips the self-shove echo for humans) - silent expiry.
        if (!s.self) {
          // Refused verdict - reverse the predicted impulse so a phantom
          // shove stops displacing the body into the next blast's eval.
          if (s.iv) {const v = deps.lazyPlayer().vel; if (v) {v.x -= s.iv.x; v.y -= s.iv.y; v.z -= s.iv.z;}}
          const wa = s.wireAt;
          const kind = s.pid && !wa ? 'kb-pop-div' : 'kb-echo';
          parityMiss(kind, Object.assign({ x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z), by: s.by, f: s.f, ageMs: Math.round(now - s.t) },
            s.pop ? { pop: s.pop } : {},
            s.m === undefined ? {} : { m: s.m },
            s.wt === undefined ? {} : { wt: s.wt },
            wa ? { wa: `${wa.x.toFixed(0)},${wa.y.toFixed(0)},${wa.z.toFixed(0)}`, offM: Number(Math.hypot(s.x - wa.x, s.y - wa.y, s.z - wa.z).toFixed(1)) } : {}));
        }
        kbStamps.splice(i, 1);
      }
    }
  }
  // Gate shields read team off the sim state - keep it synced to the
  // wire team (rebalances/teamUpdate can flip it mid-match).
  player.movement.getState().team = deps.world.localTeam;
  // A terrain swap mid-window seats the player on the room's field while
  // the resident heightmap is still the boot one - simulating here falls
  // the body toward boot-ground and earns a 40m+ correction snap when the
  // server disagrees. The hold covers the whole pending window, not just
  // the swap body's execution - the seat lands before the swap starts.
  if (!isTerrainSwapPending()) {player.update(dt);}
  if (isPosPrimed()) {
    const jump = player.pos.distanceTo(_posPrev);
    if (jump > JUMP_FRAME_M && performance.now() - _posJumpLastAt > 1000) {
      _posJumpLastAt = performance.now();
      Logger.warn(`POS JUMP ${jump.toFixed(1)}m in one frame - (${_posPrev.x.toFixed(1)},${_posPrev.y.toFixed(1)},${_posPrev.z.toFixed(1)}) → (${player.pos.x.toFixed(1)},${player.pos.y.toFixed(1)},${player.pos.z.toFixed(1)}) dead=${player.isDead}`);
    }
  }
  _posPrev.copy(player.pos);
  setPosPrimed(true);
  terrain.update(player.pos.x, player.pos.z);
  syncFog(deps, terrain);

  // Position send even when hidden - the server needs liveness. Runs
  // unconditionally: sends no-op while disconnected (ws?.connected()
  // guards inside), but gating the whole tick on the socket froze every
  // remote/bot indicator mid-screen for the life of a flap.
  // Remotes keep ticking while you're dead - the death cam still watches
  // the world, and the position send is also the server's liveness proof.
  perf.mark('playerSim');
  if (!demoManager?.isPlaying) {
    deps.remotes().networkTick(dt);
  }
  terrain.updateRemoteDetail(deps.world.remotePlayers.values());
  perf.mark('player');

  const demoPaused = tickDemo(deps, dt);
  if (demoPaused) {return true;}

  if (bootHoldActive(f)) {return false;}
  tickEntities(deps, perf, dt, demoManager?.isPlaying ?? false, bootReleased, f.rawDt);
  return false;
}

/** Stage 2 - transient VFX on wall-clock fxDt so they decay while the
 *  tab is hidden instead of stacking into an overdraw bomb. Profiled the
 *  hottest stage under fire (~5ms in a debris storm): the list updates
 *  run as budgeted jobs under an ms cap, rotated each frame so sustained
 *  load starves every list evenly instead of tail-dropping the last two.
 *  Skipped frames are absorbed by the dt-based decay. */
const FX_MS_CAP = 1.2;
function fxTick(deps: GameLoopDeps, st: LoopState, budget: ReturnType<typeof createFrameBudget>, fxDt: number): void {
  // vfx runs OUTSIDE the rotation: batcher.update must tick every frame
  // (particles freeze otherwise) and its bookkeeping is what keeps the
  // sim bounded - deferring it under load let `live` balloon past the
  // old cap (seen: 1201 systems → 10-24ms vfx frames).
  const v0 = performance.now();
  updateVfx(fxDt, deps.camera.position);
  tickUnderwaterGrade(deps.camera.position.y); // no-op on dry maps
  fxJobSample('vfx', performance.now() - v0);
  // ?nanscan=1 - cheap watchdog for the "giant black triangle" class of
  // bug: a non-finite/insane vertex in ANY dynamic buffer rasterizes as
  // a fullscreen quad (undefined per spec), indistinguishable from a
  // bloom smear except that HUD/viewmodel survive. Scans scene buffers.
  if (NANSCAN) {
    nanScanTick(deps.sceneSetup.scene, deps.camera);
    if (!nanProbeBound) {
      nanProbeBound = true;
      nanScanBindProbe((): { scene: THREE.Scene<THREE.Object3DEventMap>; camera: THREE.PerspectiveCamera; } => ({ scene: deps.sceneSetup.scene, camera: deps.camera }));
    }
  }
  st.fxJobs.length = 0;
  st.fxJobs.push(
    ['effects', (): void => deps.lazyEffects().update(fxDt)],
    ['debris', (): void => updateDeadList(deps.world.debrisList, fxDt)],
    ['pdebris', (): void => {
      const list = deps.world.playerDebrisList;
      const cam = deps.camera.position;
      // A nearby mass kill otherwise turns this one job into a 7ms+
      // spike: past the cap, remaining debris take a ~zero deadline -
      // the same resumable slice path far debris already use.
      const t0 = performance.now();
      let i = list.length - 1;
      for (; i >= 0; i -= 1) {
        const d = list[i]!;
        const dx = d.ox - cam.x, dy = d.oy - cam.y, dz = d.oz - cam.z;
        if (dx * dx + dy * dy + dz * dz < VFX_NEAR_SQ) {
          // Resumable shard budget - one debris can't overdraw the cap.
          d.update(fxDt, 1.5 - (performance.now() - t0));
          if (performance.now() - t0 > 1.5) {i -= 1; break; }
        } else {d.update(fxDt, 0.15);} // far: resumable ~1-shard slice -
        // tickAge froze shards mid-air at spawn positions for their
        // whole 6-8s life (same parked-ring bug as Explosion.tickAge)
        if (d.dead) { d.dispose(); list.splice(i, 1); }
      }
      for (; i >= 0; i -= 1) {
        const d = list[i]!;
        d.update(fxDt, 0.05); // over-budget tail - one shard a frame still beats frozen chunks
        if (d.dead) { d.dispose(); list.splice(i, 1); }
      }
    }],
    ['gibs', (): void => updateGibs(fxDt)],
    ['swipes', (): void => updateSwings(fxDt, deps.camera)],
    ['scorch', (): void => {
      updateDeadList(deps.world.scorches, fxDt);
      updateDeadList(deps.world.splats, fxDt);
    }],
    ['explosions', (): void => {
      const ex = deps.world.explosions;
      for (let i = 0; i <= ex.length - MAX_LIVE_EXPLOSIONS; i += 1) {ex[i]!.dead = true;}
      // Same 260m rule as the vfx sim-pause - a blast past it is sub-pixel,
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
    ['implosions', (): void => updateDeadList(deps.world.implosions, fxDt)],
    ['aoegiz', (): void => updateDeadList(deps.world.aoeGizmos, fxDt)],
  );
  if (st.fxCursor > 0) {st.fxJobs.push(...st.fxJobs.splice(0, st.fxCursor));}
  st.fxCursor = (st.fxCursor + 1) % st.fxJobs.length;
  budget.each('fxdecay', st.fxJobs, FX_MS_CAP, ([name, run]): void => {
    const t0 = performance.now();
    run();
    fxJobSample(name, performance.now() - t0);
  });
  // Deferred lists resume on their own next frame - nothing carries over.
  st.fxJobs.length = 0;
}

// Player/bot minimap blips - same friend-or-foe rule as the overhead
// markers: wire team (or GameBot.team) matching localTeam = green, else
// red. Dead and cloaked riders are dropped - no corpse pings, no cloak
// leak.
function fillMapBlips(deps: GameLoopDeps, networkManager: TickFrame['networkManager']): void {
  const wirePlayers = networkManager.getPlayers();
  let blipN = 0;
  deps.world.remotePlayers.forEach((rp, id): void => {
    // A fire-revealed cloak (ghostT live) blips like any visible rider -
    // the shimmer window already sold him out to eyes and HUD.
    if (rp.isDead || (rp.isCloakHidden && rp.ghostT <= 0)) {return;}
    const team = (rp as { team?: string }).team ?? wirePlayers.get(id)?.team;
    // Reused buffer - a fresh object per remote per frame was ~1.2k
    // throwaway blips/s of pure GC churn.
    let b = _mapBlips[blipN];
    if (!b) { b = { x: 0, z: 0, friendly: false, bot: false }; _mapBlips.push(b); }
    b.x = rp.position.x; b.z = rp.position.z;
    b.friendly = Boolean(team) && team === deps.world.localTeam; b.bot = isBotId(id);
blipN += 1;
  });
  _mapBlips.length = blipN;
}

/** Stage 3 - HUD + viewmodel + ambient/atmosphere, then render. */
function hudTick(deps: GameLoopDeps, st: LoopState, budget: ReturnType<typeof createFrameBudget>, perf: ReturnType<typeof createPerfHud>, f: TickFrame, fxDt: number): void {
  const { dt, player, networkManager, demoManager } = f;
  const { camera, sceneSetup, entities } = deps;
  const hud = deps.lazyHud();
  const viewModel = deps.lazyViewModel();
  const terrain = deps.lazyTerrain();

  // Boot hold hides the HUD too - the world renders through warmup but
  // ammo/health/timer shouldn't flash over the frozen match. Transition-
  // gated so release can't stomp another owner's hide() (spectate/death).
  const held = bootHoldActive(f);
  // Route every shadowMap.enabled flip through setShadows - the raw
  // toggle leaves shadow-compiled programs live, and the next render
  // dies uploading shadowIntensity uniforms the lights state lacks.
  if (held && !st.hudHeld) { st.hudHeld = true; hud.hide(); setBootVeil(true); setShadows(deps, false); if (isSessionVeiled()) {deps.rendererSetup.setPostProcessingEnabled(false, false);} }
  else if (!held && st.hudHeld) { st.hudHeld = false; hud.show(); setBootVeil(false); setShadows(deps, settings.get('fps-shadows')); deps.rendererSetup.setPostProcessingEnabled(settings.get('fps-postpro'), false); }

  hud.update(dt, player, networkManager.getPing(), networkManager.getPacketLoss(), networkManager.getJitter());
  hud.setConnDown(networkManager.connectionDown(), networkManager.connectionDownReason());
  const playerSheep = deps.lazyPlayerSheep?.();
  if (playerSheep) {
    playerSheep.tick(dt, player, terrain, deps.world.remotePlayers, deps.world.localTeam);
  }
  // Under-crosshair probes (sheep / mechanical energy / ground distance)
  // are dev readouts - debug toggle only, like the terrain wire.
  if (urlParams.debug) {
    if (playerSheep) {
      hud.setSheep(playerSheep.shown);
      hud.setEnergy(playerSheep.energy);
    }
    hud.setGround(player.onGround, player.pos.y - terrain.getHeight(player.pos.x, player.pos.z));
  } else {
    hud.setSheep(0); hud.setEnergy(undefined); hud.groundReadout.textContent = '';
  }
  // Self blob - the first-person body never reaches the shadow pass, so
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
  // Entity-count text is a slow-moving counter - 10Hz is plenty.
  budget.sweep('census', 100, (): void => hud.setEntityCounts(censusEntities(deps, entities)));
  // Belt charges ARE the nugget wallet - spawn stock + pickups, spent by
  // throws/deploys. (nuggetsCollected only counts pickups, so the HUD
  // read 0 at spawn even though the belt economy starts at BELT_MAX.)
  hud.setNuggets(player.beltCharges);
  hud.setHeld(deps.world.mode === 'headhunt' ? player.heldTokens : null);
  // The run clock only ticks offline - show it only then, else it's a
  // frozen 00:00 under the FPS counter in every match.
  hud.setTimerVisible(!(demoManager?.isPlaying ?? false) && !networkManager.isConnected() && !CLASSIC_MODE);
  hud.setTimer(deps.waveDirector().elapsed);
  // Classic's Unity-style top-center readout owns the clock - the
  // corner timer hides so they don't double up. Classic is a solo mode:
  // a joined session in the same page keeps CLASSIC_MODE true and the
  // readout would linger over the online HUD.
  hud.setClassicScore(CLASSIC_MODE && !networkManager.isConnected()
    ? { score: player.score, kills: player.kills, seconds: deps.waveDirector().elapsed }
    : null);
  // The team-score strip has no per-frame owner: solo modes set it
  // once and it stays up. Hide it when connected to a mode that
  // doesn't write it - team modes online re-set it via match.ts anyway.
  if (networkManager.isConnected() && !['nuggets', 'ctf', 'flagrun', 'conquest', 'headhunt'].includes(deps.world.mode ?? '')) {
    hud.hideTeamScore();
  }
  hud.setMatchStatus(
    deps.world.matchEndsAt ? deps.world.matchEndsAt - Date.now() : null,
    deps.world.flagStates,
  );
  hud.updateDeathCountdown(deps.world.respawnMs, player.respawnHeld);
  // Every frame - a rotating radar at the 25Hz sweep cadence reads as
  // visibly choppy next to the 60fps world, and the redraw is ~30 arcs.
  deps.ambientBirds.positions(_birdPosBuf);
  fillMapBlips(deps, networkManager);
  hud.updateMinimap(entities.targets, entities.nuggets, player.pos, player.yaw, _birdPosBuf, _mapBlips, deps.world.nodeMarkers.values());
  if (hud.commandMapOpen) {hud.updateCommandMap(player.pos, player.yaw, _mapBlips, deps.world.flagMarkers, deps.world.nodeMarkers, deps.world.spawnPools);}

  // During demo playback the vm mirrors the frame's recorded weaponType -
  // hiding it would strip the shooter POV from cool-shot clips.
  // The middle-click orbit cam IS a third-person view while it's on -
  // hiding the FP gun is what stops "your own gun plus your own model".
  viewModel.group.visible = !bootHoldActive(f) && !player.isDead && !player.thirdPerson && !player.isSpectating && !player.input.midHeld;
  const yawDelta = Math.atan2(Math.sin(player.yaw - st.lastYaw), Math.cos(player.yaw - st.lastYaw));
  // Paused demo = frozen world - the vm's idle sway/bob reads as the scene
  // still playing. dt=0 freezes the anims; the weapon itself stays bound
  // to the recorded frame's weaponType via onPlaybackState.
  viewModel.update(demoManager?.isPaused ? 0 : dt, yawDelta, player.pitch - st.lastPitch, player.vel, camera, player.shootAnimTimer > 0);
  st.lastYaw = player.yaw;
  st.lastPitch = player.pitch;
  perf.mark('viewmodel');
  deps.lazyHealthBarSystem().update(dt,
    demoManager?.isPlaying ? deps.world.playbackPlayers : networkManager.getPlayers(),
    demoManager?.isPlaying ? deps.world.playbackRemotePlayers : deps.world.remotePlayers,
    entities.balls, deps.world.localTeam);
  perf.mark('healthbars');

  // Peripheral speed lines along the true velocity vector; demo-suppressed.
  deps.speedLines.update(fxDt, camera.position, demoManager?.isPlaying ? _zeroVel : player.vel);

  if (st.cpuLevel === 0) {
    deps.weather.update(fxDt, camera.position, terrain);
    deps.groundMist().update(fxDt, camera.position);
    deps.ambientBirds.update(fxDt, player.pos, terrain, player.isDead);
  }
  perf.mark('ambient');

  sceneSetup.update(dt);
  sceneSetup.atmosphericSky.followCamera(camera.position);
  sceneSetup.updateCamera(camera);

  // Shake composes after player.update's camera write; the LG beam weld
  // is last - it needs the swayed viewmodel AND the post-shake camera or
  // fast moves leave the bolt a frame stale.
  screenShake.update(dt, camera);
  deps.combat()?.updateBeamVisual();
  sfxAudio.updateAudio(dt, player, camera);
  perf.mark('scene');
}


// stats.js perf panels - FPS/MS/MB in a row along the bottom-right,
// toggled with ` (backquote). stats.js only renders one panel per
// instance, so use one per metric; panels are 80px wide + 8px gap.
function makeStatsPanels(): Stats[] {
  // One row in the BR region stack (order 2, hud.css) — panels flow
  // left-to-right inside it; hidden/display toggles reflow the column.
  const row = document.createElement('div');
  row.id = 'stats-row';
  hudRegion('br').append(row);
  return [0, 1, 2].map((panel, i): Stats => {
    const s = new Stats();
    s.showPanel(panel);
    const dom = s.dom as HTMLElement;
    dom.id = `stats-${i}`;
    dom.style.cssText = 'position:static;display:none;';
    row.append(dom);
    return s;
  });
}

function wireDebugKeys(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, budget: ReturnType<typeof createFrameBudget>, statsPanels: ReturnType<typeof makeStatsPanels>): void {
  // window.__perf - live phase table for headless probes + manual reads;
  // the watchdog dump uses the same data for shipped logs.
  window.__perf =
    () => (Object.assign({}, perf.snapshot(), {gpu: gpuMs()}, budget.stats() as unknown as Record<string, number>, fxJobStats(), {draws: deps.rendererSetup.renderer.info.render.calls,trisK: Number((deps.rendererSetup.renderer.info.render.triangles / 1000).toFixed(0))}));
  // Debug-only handles (__renderScan/__scene/__renderer, geoNaN watch)
  // stay off prod - __perf/__trailDump/__renderDump stay since the shipped
  // watchdog dump reads them.
  if (isDevHost()) {
    // window.__renderScan - staged render breakdown (scene / +shadow / full
    // pipeline / viewmodel) with per-stage calls+tris+GPU-ms. Profiling
    // hook; renders extra frames on top of the loop.
    window.__renderScan = createRenderScan(deps);
    // __scene/__renderer - profiling handles for headless probes
    // (per-class triangle census, ad-hoc visibility A/Bs). Debug-only.
    window.__scene = deps.sceneSetup.scene;
    window.__renderer = deps.rendererSetup.renderer;
    // geoNaN watch - names the owner of any buffer whose bounding sphere
    // computes NaN (the spam was ownerless before this probe existed).
    installGeoNaNWatch(deps.sceneSetup.scene);
  }
  // __trailDump - merged census of every self-registered FX diag section
  // (ribbons/vfx/inst/swarm…). Sections come from registerDiag() in the
  // owning modules, so new censuses never touch this wiring.
  window.__trailDump = collectDiag;
  document.addEventListener('keydown', (e): void => {
    // Alt+W - bot weapon audit: last gun each bot drew + its shot count,
    // so "do they fire real weapons" is a one-keypress read. Alt+Shift+W
    // keeps the old hard-reload hatch (F5 is flaky under pointer lock).
    if (e.altKey && e.code === 'KeyW') {
      e.preventDefault();
      if (e.shiftKey) { window.location.reload(); return; }
      const rows = [...lastWeaponByPlayer.entries()]
        .filter(([id]): boolean => isBotId(id))
        .map(([id, r]): string => `${id} ${WeaponType[r.wt] ?? `w${r.wt}`} shots=${r.n}`);
      Logger.info(rows.length > 0 ? `[botweapons] ${rows.join(' | ')}` : '[botweapons] no bot fire seen yet');
      return;
    }
    // Debug console - dev hosts only: on the https deploy the stats/log
    // panels must be dead keys (Alt+Q still ships logs for bug reports).
    if (e.code === 'Backquote' && isDevHost()) {
      e.preventDefault();
      const show = (statsPanels[0]!.dom as HTMLElement).style.display === 'none';
      for (const s of statsPanels) {
        (s.dom as HTMLElement).style.display = show ? 'block' : 'none';
      }
      perf.setVisible(show);
      // Bottom-right entity census is debug data too - same toggle.
      deps.lazyHud().setEntCountsVisible(show);
      // The log mirror rides the same debug view.
      setLogOverlayVisible(show);
      // Sheep meters over remote heads are debug data too - the
      // standing badge is HP without the overlay.
      setDebugOverlays(show);
      // Debug chrome changes the corner stack - audit for collisions the
      // frame after the layout settles.
      if (show) {requestAnimationFrame((): number => requestAnimationFrame(reportHudOverlap));}
    }
  });
}

// Interior shadow casters distance-gated like remotes: only near-camera
// architecture darkens the map; far towers' shadows are unreadable.
// Census showed ~700 caster meshes - at a base view they were half the
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

// Shader warmup - programs used to compile lazily mid-frame and hitch the
// first ~10s after join (render 116-134ms measured). Once the world content
// has landed, compileAsync parallel-compiles every scene material instead
// of stalling individual draws. Post-warmup stragglers (a remote's rig
// lands after join) get the same pass debounced - a profile of a live
// fight showed per-program onFirstUse validation burning ~10% of the
// frame while new materials trickled in.
function maybeWarmShaders(deps: GameLoopDeps, st: LoopState): void {
  if (st.warmed) {
    const rewarm = st.rewarmT ?? 0;
    if (rewarm > 0) {
      st.rewarmT = rewarm - 1;
      if (st.rewarmT === 0) {
        // compileAsync's serial link+introspection is a live-frame block
        // - count it so the veil never drops into a mid-warm hitch.
        pendingHeavy.n += 1;
        Promise.resolve(deps.rendererSetup.warmup()).finally((): void => { pendingHeavy.n -= 1; });
      }
    }
    const count = deps.world.remotePlayers.size;
    if (count !== (st.lastRemoteCount ?? 0)) {st.lastRemoteCount = count; st.rewarmT = 90;}
    return;
  }
  if ((st.warmN += 1) === 1) {
    // Full-model warm: detached PlayerModels per class variant fill the
    // retarget/atlas/AO caches the clone shelf doesn't touch. Kick at
    // first tick (not after shader-warm ~18s) so pendingHeavy holds the
    // veil over the whole multi-second bake instead of leaking it onto
    // live frames - the veil-gate fix only covers loads it sees early.
    const scratch = new THREE.Group() as unknown as THREE.Scene;
    for (const v of ['scout', 'brawler', 'brute'] as const) {
      const m = new PlayerModel(scratch, v);
      m.load({ veil: false }).then((): void => m.dispose()).catch((): void => undefined);
    }
  }
  if (st.warmN <= 60) {return;}
  // getObjectByName walks the whole scene - poll every 30 ticks instead of
  // per frame while interiors land (a live profile caught the scan at ~2%
  // of a match profile through getObjectByProperty).
  if (st.warmN <= 600 && (st.warmN % 30 !== 0 || !deps.sceneSetup.scene.getObjectByName('__t2interiors'))) {return;}
  st.warmed = true;
  pendingHeavy.n += 1;
  Promise.resolve(deps.rendererSetup.warmup()).finally((): void => {
    pendingHeavy.n -= 1;
    performance.mark('load:shaderWarmDone');
  });
  // Pre-clone each armor-class rig so a mid-match join grabs one off
  // the shelf instead of paying SkeletonUtils.clone on the live frame.
  // Depth 4/variant - a 15-bot churn exhausts 2 before the macrotask
  // refill lands, so joins past the second still clone on the frame.
  for (const v of ['scout', 'brawler', 'brute'] as const) {warmRig(v, 4);}
  // One underground blast fills the burst-spec freelists, so the first
  // real explosion restarts pooled systems instead of paying cold
  // ParticleSystem builds mid-fight. 500m down it never renders.
  deps.world.explosions.push(new Explosion(deps.sceneSetup.scene, _prewarmPos, false, 0, deps.lazyTerrain(), 1));
}

const _prewarmPos = new THREE.Vector3(0, -500, 0);

// FPS cap: skip only the render call - sim/input stay full-rate.
// Carry leftover time so the cap hits its target rate, not stutters.
function fpsCapAllows(st: LoopState, rawElapsed: number): boolean {
  const cap = settings.get('fps-cap') || st.autoCap || 0;
  if (cap <= 0) {return true;}
  st.renderAcc += rawElapsed;
  if (st.renderAcc < 1 / cap) {return false;}
  st.renderAcc = Math.min(st.renderAcc - 1 / cap, 1 / cap);
  return true;
}

function aimDebugAfterVeil(deps: GameLoopDeps): void {
  const ray = new THREE.Raycaster();
  let n = 0;
  const snap = (): void => {
    ray.setFromCamera(new THREE.Vector2(0, 0), deps.camera);
    const vmScene = deps.vmScene();
    const vmRay = new THREE.Raycaster();
    vmRay.setFromCamera(new THREE.Vector2(0, 0), deps.vmCamera());
    const vmHits = vmRay.intersectObjects(vmScene.children, true)
      .filter((h): boolean => {
        for (let p: THREE.Object3D | null = h.object; p; p = p.parent) {if (!p.visible) {return false;}}
        return true;
      })
      .slice(0, 4)
      .map((h): string => `vm ${h.distance.toFixed(2)}m ${h.object.type}${h.object.name ? `(${h.object.name})` : ''}`);
    const hits = ray.intersectObjects(deps.sceneSetup.scene.children, true)
      .filter((h): boolean => {
        for (let p: THREE.Object3D | null = h.object; p; p = p.parent) {if (!p.visible) {return false;}}
        return true;
      })
      .slice(0, 4)
      .map((h): string => {
        let chain = '';
        let depth = 0;
        for (let p: THREE.Object3D | null = h.object; p && depth < 4; p = p.parent) {chain += `${p.type}${p.name ? `(${p.name})` : ''}<`; depth += 1;}
        const m = (h.object as THREE.Mesh).material as THREE.Material | undefined;
        return `${h.distance.toFixed(1)}m ${chain} mat=${m?.type ?? '?'} col=${(m as THREE.MeshBasicMaterial)?.color?.getHexString?.() ?? '?'}`;
      });
    // Some blobs slip the ray (frustumCulled clones, skinned bounds,
    // non-mesh drawables) - census any visible object whose bounding
    // sphere contains the camera, plus whatever DOM sits at dead center.
    const cam = deps.camera.getWorldPosition(new THREE.Vector3());
    const containing: string[] = [];
    const bs = new THREE.Sphere();
    deps.sceneSetup.scene.traverse((o): void => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (!g) {return;}
      for (let p: THREE.Object3D | null = o; p; p = p.parent) {if (!p.visible) {return;}}
      if (!g.boundingSphere) {g.computeBoundingSphere();}
      const s = g.boundingSphere;
      if (!s) {return;}
      bs.copy(s).applyMatrix4(o.matrixWorld);
      if (bs.distanceToPoint(cam) <= 0) {
        let chain = '';
        let d = 0;
        for (let p: THREE.Object3D | null = o; p && d < 4; p = p.parent) {chain += `${p.type}${p.name ? `(${p.name})` : ''}<`; d += 1;}
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        containing.push(`${chain} r=${bs.radius.toFixed(1)} mat=${m?.type ?? '?'} col=${(m as THREE.MeshBasicMaterial)?.color?.getHexString?.() ?? '?'}`);
      }
    });
    const dom = document.elementsFromPoint(innerWidth / 2, innerHeight / 2)
      .map((e): string => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${(e as HTMLElement).className ? `.${String((e as HTMLElement).className).split(' ')[0]}` : ''}`)
      .slice(0, 6);
    Logger.info(`[veil-drop aim f${n}]`, { hits, vmHits, containing, dom });
    n += 1;
    if (n < 12) {requestAnimationFrame(snap);}
  };
  requestAnimationFrame(snap);
}

let veilStillFrames = 0;
const veilPrevPos = new THREE.Vector3();

function tickVeil(deps: GameLoopDeps, st: LoopState, rawElapsed: number, draw: (dt: number) => void): boolean {
  // The per-frame hide in Player.update is skipped while veiled, so the
  // boot body would render around a camera still at its pre-restore spot.
  const pl = deps.lazyPlayer();
  pl.model?.setVisible(false);
  // Camera writes live in the normal update, which is skipped while veiled -
  // place the camera on the body now so the last veiled frame matches the
  // first live one (a camera left at the origin is what the veil-drop shows).
  deps.camera.position.copy(pl.pos); // pos.y is already the eye - adding the eye height here lifted the veil camera ~1.6m off the live one
  deps.camera.rotation.set(pl.pitch, pl.yaw, 0, 'YXZ');
  // Shader programs for the body appear on first VISIBLE draw - compile them
  // here, under the veil, or the first live frame stalls on the GPU driver.
  if (st.veilFrames === 0) {
    pl.model?.setVisible(true);
    performance.mark('load:veilCompileStart');
    deps.rendererSetup.renderer.compile(deps.sceneSetup.scene, deps.camera);
    performance.mark('load:veilCompileDone');
    pl.model?.setVisible(false);
  }
  // Draw the REAL frame path - composer, viewmodel pass, post pipeline,
  // shadow gating. A bare renderer.render warms only the base scene and
  // reads "stable" while the first live renderFrame stalls seconds
  // compiling programs the veil never drew - that stall IS the still
  // frame the veil was hiding. Veil-drop continuity follows for free:
  // the last veiled frame is pixel-identical to the first live one.
  draw(rawElapsed);
  st.veilFrames += 1;
  if (rawElapsed < 0.026) {st.veilStable += 1;} else {st.veilStable = 0;}
  // Seated = a wire position actually landed (respawn or gameState
  // restore). Without it the veil could drop while pos is still the
  // boot default - the first live frames then render under terrain
  // wherever the origin sits (and the first claims read as a dive).
  // The 10s frame cap is the escape for a seat that never arrives.
  // The body must stand on the DRAWN ground, not just the collider: the
  // camera follows the body, so a feet point under the visible chord is
  // exactly the under-terrain first frame. Camera updates are skipped
  // while veiled, so the body is the signal to wait on.
  const p = deps.lazyPlayer().pos;
  if (st.veilFrames === 0) {veilStillFrames = 0;}
  veilStillFrames = p.distanceToSquared(veilPrevPos) < 0.0025 ? veilStillFrames + 1 : 0;
  veilPrevPos.copy(p);
  const grounded = p.y >= deps.lazyTerrain().getRenderedHeight(p.x, p.z) - 0.1;
  // A seat that is still settling (gameState / reconcile writes after the
  // respawn) would otherwise lift the veil on the old spot and snap to the
  // real one - hold until the body has stopped moving for ~1s.
  const placed = (isSessionSeated() && grounded && veilStillFrames >= 60 && !isTerrainSwapPending()) || st.veilFrames >= 600;
  // Ready to go live UNDER the veil - the caller runs the full loop from
  // here and only drops once REAL frames hold <26ms. Measuring stability
  // on veiled frames was the bug: a veiled frame skips the whole sim, so
  // the drop landed exactly as the expensive loop started - the "still
  // frame for ~3s" was deferred shader compiles + first sim ticks.
  return isSessionVeilReady() && placed && !deps.lazyPlayer().isDead;
}

export function createGameLoop(deps: GameLoopDeps): { start(): void; whenStable(): Promise<void>; renderFrame(dt: number): void; } {
  let lastTime = 0;
  let renderElapsed = 0;
  const st: LoopState = { lastYaw: 0, lastPitch: 0, lowFpsFrames: 0, lowFpsAccum: 0, lastFpsDump: 0, gpuLevel: 0, cpuLevel: 0, cpuBound: false, headroomAccum: 0, autoPixel: false, fxCursor: 0, fxJobs: [], shadowAcc: 0, renderAcc: 0, autoCap: null, warmN: 0, warmed: false, veilStable: 0, veilFrames: 0, veilLive: false, veilLiveFrames: 0, veilFroze: false, bootWarmup: new BootWarmup() };

  // stats.js perf panels - FPS/MS/MB in a row along the bottom-right,
  // toggled with ` (backquote). stats.js only renders one panel per
  // instance, so use one per metric; panels are 80px wide + 8px gap.
  const statsPanels = makeStatsPanels();
  const perf = createPerfHud();
  // AUTO QUALITY toggle (top of SETTINGS): off freezes the ladder where it
  // is AND restores full quality, so the user isn't left on a preset they
  // never picked. No reload - ladders gate on the setting live.
  const autoqBtn = document.querySelector('#autoq-toggle') as HTMLButtonElement | null;
  if (autoqBtn) {
    const label = (): void => { autoqBtn.classList.toggle('on', Boolean(settings.get('fps-autoq'))); };
    label();
    autoqBtn.addEventListener('click', (): void => {
      const on = !settings.get('fps-autoq');
      settings.set('fps-autoq', on);
      if (!on) {resetAutoQuality(deps, st);}
      label();
    });
  }
  // FPS CAP - render skip only; sim/input keep full rAF rate. A real
  // vsync-off isn't possible in a browser, but capping buys battery on
  // chromebooks and headroom measurement on high-refresh displays.
  const FPS_CAPS = [0, 30, 60, 120];
  const capBtn = document.querySelector('#fpscap-toggle') as HTMLButtonElement | null;
  if (capBtn) {
    const label = (): void => { const c = settings.get('fps-cap'); capBtn.textContent = c > 0 ? `FPS CAP: ${c}` : 'FPS CAP: OFF'; };
    label();
    capBtn.addEventListener('click', (): void => {
      const i = FPS_CAPS.indexOf(settings.get('fps-cap'));
      settings.set('fps-cap', FPS_CAPS[(i + 1) % FPS_CAPS.length]!);
      st.renderAcc = 0;
      label();
    });
  }
  // Frame-budget runner - ms-quota chunking + phased sweeps for work
  // that's expensive but not frame-critical. First pilot: the minimap
  // sweep at 25Hz (full-rate blip redraw was invisible anyway).
  const budget = createFrameBudget();
  wireDebugKeys(deps, perf, budget, statsPanels);

  let gpuSeeded = false;
  function loop(time: number): void {
    requestAnimationFrame(loop);
    const rawElapsed = (time - lastTime) / 1000;
    const dt = Math.min(Number.isFinite(rawElapsed) ? Math.max(rawElapsed, 0) : 0, MAX_DELTA_TIME);
    if (Number.isFinite(time)) {lastTime = time;}
    // One-shot: iGPU/software renderer strings start mid-ladder instead
    // of grinding ~10s of <40fps per watchdog step to reach the floor.
    if (!gpuSeeded) {gpuSeeded = true; seedGpuTier(deps, st); performance.mark('load:loopFirst');}
    fpsWatchdog(deps, st, budget, perf, rawElapsed, time);
    // Veiled = waiting on gameState - don't sim or take input, but DO
    // render: shader/pipeline warmup needs real draws or it fires on
    // the player's first interactive frame. The veil drops once state
    // landed AND ~45 stable frames ran (180-frame cap = safety valve).
    // Boot warmup counter runs even while veiled - the veil block counts
    // its own renders separately; here we meter real frames.
    st.bootWarmup.tick(rawElapsed);
    if (isSessionVeiled()) {
      if (isSessionVeilReady() && !st.terrainCompiled) {
        st.terrainCompiled = true;
        performance.mark('load:terrainWarmupStart');
        deps.rendererSetup.warmup();
        performance.mark('load:terrainWarmupDone');
        renderFrame(0.016);
      }
      if (!st.veilLive) {
        st.veilLive = tickVeil(deps, st, rawElapsed, renderFrame);
        if (!st.veilLive) {return;}
        // Going live under the veil: input stays frozen (a stray click
        // shouldn't fire while a RECONNECTING screen is up) until the
        // drop. veilStable counts REAL frames now.
        if (!deps.lazyPlayer().inputFrozen) {deps.lazyPlayer().freezeInput(); st.veilFroze = true;}
        st.veilStable = 0; st.veilLiveFrames = 0;
      }
    } else {
      // The 8s force-drop timer can clear the veil outside our drop -
      // release any input freeze we own either way.
      if (st.veilFroze) {deps.lazyPlayer().unfreezeInput(); st.veilFroze = false;}
      st.veilLive = false;
    }
    perf.begin(deps.rendererSetup.renderer);

    // Hidden tabs get ~1 rAF/sec - dt clamps to 0.05 so game logic runs in
    // slow motion, but cosmetic VFX must still expire in real time or they
    // stack into an overdraw bomb while you're AFK. fxDt = wall-clock
    // (clamped 2s) when hidden; normal dt when visible.
    const fxDt = document.hidden ? Math.min(rawElapsed, 2) : dt;

    const player = deps.lazyPlayer();
    const terrain = deps.lazyTerrain();
    const networkManager = deps.lazyNetworkManager();
    const demoManager = deps.lazyDemoManager();

    const frame: TickFrame = { dt, rawDt: Number.isFinite(rawElapsed) ? Math.min(Math.max(rawElapsed, 0), 2) : dt, player, networkManager, demoManager, bootReleased: st.bootWarmup.released };
    // Late-bound once: the ops uplink reads the perf EMA (JS frame cost +
    // real present rate) but perf doesn't exist until the loop starts.
    if (!networkManager.statsSource) {
      networkManager.statsSource = (): { fps: number; jsMs: number; renderLagMs: number; renderLag: Record<string, number>; starve: number; starveMs: number; } => {
        const s = perf.snapshot();
        // Per-victim render delay map - rewinding every victim by the
        // MAX delay validates ~500ms behind a fast ghost the shooter is
        // actually tracking at ~100ms: the classic "numbers, no damage".
        // renderLagMs stays as the fallback for old wires/creatures.
        let renderLagMs = 0, starve = 0, starveMs = 0;
        const renderLag: Record<string, number> = {};
        deps.world.remotePlayers.forEach((rp, id): void => {
          // viewLag (actual sample staleness incl. extrapolation), not
          // the delay setting - the server rewinds to THIS epoch.
          renderLag[id] = rp.viewLagMs;
          if (rp.viewLagMs > renderLagMs) {renderLagMs = rp.viewLagMs;}
          starve += rp.interpUnderruns;
          starveMs += rp.interpExtCapMs;
        });
        return { fps: s.frame > 0 ? Math.round(1000 / s.frame) : 0, jsMs: s.frame, renderLagMs, renderLag, starve, starveMs };
      };
    }
    const demoPaused = simTick(deps, perf, frame, terrain);
    if (!demoPaused) {fxTick(deps, st, budget, fxDt);}
    perf.mark('fx');
    deps.remotes().updateScoreboard();

    // Deep-telemetry drift census (~4Hz): rendered pos vs the remote's
    // wire-projected truth - the replica-fidelity population netsoak's
    // DESYNC line only samples per hash tick.
    if (telemetry.enabled && Date.now() - lastDriftMs > 250) {
      lastDriftMs = Date.now();
      deps.world.remotePlayers.forEach((rp, id): void => {
        if (rp.isDead || rp.lastUpdateTime <= 0) {return;}
        const age = Math.min((Date.now() - rp.lastUpdateTime) / 1000, 1);
        _driftVec.copy(rp.wirePosition).addScaledVector(rp.vel, age);
        recDrift(id, _driftVec.distanceTo(rp.position), age * 1000);
      });
    }

    // ?dummy debug remote - pin it in front of the camera and tick it
    const dummy = deps.world.remotePlayers.get('dummy');
    const dummyTick = deps.getDummyTick();
    if (dummyTick) { dummyTick(dt); if (dummy) {dummy.tick(dt);} }

    hudTick(deps, st, budget, perf, frame, fxDt);
    perf.mark('hud');

    renderElapsed += rawElapsed; // real time between presents for the FPS meter
    if (fpsCapAllows(st, rawElapsed)) {
      deps.lazyHud().markFrame(renderElapsed);
      // stats.js panels count update() calls as frames - update only on
      // real renders or the FPS panel reads the rAF rate under a cap.
      // (Still gated on display - they paint even while hidden.)
      if ((statsPanels[0]!.dom as HTMLElement).style.display !== 'none')
        {for (const s of statsPanels) {s.update();}}
      renderElapsed = 0;
      renderFrame(fxDt); // damage numbers ride fxDt - same hidden-tab decay fix
    }
    perf.mark('render');
    perf.end(deps.rendererSetup.renderer, (): string => {
      const bw = deps.lazyNetworkManager().bandwidth();
      return `tgt ${deps.entities.targets.length} rem ${deps.world.remotePlayers.size}\n` +
        `net ↑${fmtBps(bw.up)} ↓${fmtBps(bw.down)}`;
    });
    // Live-under-veil: the whole loop ran behind the overlay this frame -
    // count stability on the REAL workload and drop only once frames
    // hold <26ms. The old gate measured veiled-render-only frames (no
    // simTick/fxTick), so the veil lifted exactly as the expensive loop
    // began - that was the ~3s still frame. 480-frame cap ≈ 8s safety.
    if (isSessionVeiled()) {
      st.veilLiveFrames += 1;
      if (rawElapsed < 0.026) {st.veilStable += 1;} else {st.veilStable = 0;}
      if (st.veilStable >= 15 || st.veilLiveFrames >= 480) {
        st.veilStable = 0; st.veilLiveFrames = 0; st.veilLive = false;
        dropSessionVeil();
        if (st.veilFroze) {deps.lazyPlayer().unfreezeInput(); st.veilFroze = false;}
        aimDebugAfterVeil(deps);
      }
    }
  }

  function renderFrame(dt: number): void {
    const { camera, rendererSetup, sceneSetup } = deps;
    // FLOYD overlay hook - idempotent; the VM draw runs inside fsRender so
    // the gun lands in the readPixels buffer and gets dithered too.
    rendererSetup.setOverlayPass((): void => {
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
    // the map only re-renders every 2nd frame (≥4 every 3rd) - casters move
    // fast enough for a frame or two of lag to be invisible.
    const shadow = renderer.shadowMap;
    if (shadow.enabled) {
      const period = st.gpuLevel >= 4 ? 3 : 2;
      shadow.autoUpdate = false;
      if ((st.shadowAcc += 1) >= period) { st.shadowAcc = 0; shadow.needsUpdate = true; }
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

    // Viewmodel pass - clear depth only, draw gun on top with its own FOV.
    // Only needed on the direct-render path: FLOYD injects the same draw
    // into fsRender pre-readback, and composer modes (xBR/dithered/bloom)
    // now draw it inside the frame buffer via VmRenderPass - skipping
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
    // preserveDrawingBuffer is on - the blit must ride this same rAF.
    deps.lazyDemoManager()?.video.pump();

    // Damage numbers update after post-processing (bypass bloom/contrast for visibility)
    deps.damageNumberManager().update(dt, deps.camera);
  }

  return {
    start(): void {
       // Kick parallel compiles BEFORE frame 1: the tick-60 warmup gate
       // waits for late content, but every material already in the scene
       // would otherwise sync-compile inside its first draw - on refresh
       // that's the multi-second whole-browser ANGLE stall.
       performance.mark('load:warmupStart');
       deps.rendererSetup.warmup();
       performance.mark('load:warmupDone');
       requestAnimationFrame(loop);
     },
    /** Resolves once ~45 consecutive sub-26ms frames rendered (or 240
     *  frames pass on a weak box - never gates forever). Offline
     *  starts wait on this so the match doesn't spawn mid-compile-hitch. */
    whenStable(): Promise<void> {
      return st.bootWarmup.whenStable();
    },
    /** One synchronous render pass, callable off the rAF cadence - the
     *  offline clip renderer drives it per output frame. */
    renderFrame,
  };
}
