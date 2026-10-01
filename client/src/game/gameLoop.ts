import * as THREE from 'three';
import Stats from 'stats.js';

import { MAX_DELTA_TIME } from '../core/config.js';
import { urlParams } from '../core/params.js';
import type { DemoManager } from '../demo/index.js';
import type { Player } from '../entities/Player.js';
import { updateGibs } from '../entities/swarms.js';
import type { ViewModel } from '../entities/ViewModel.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { EffectsManager } from '../effects/effects.js';
import type { SpeedLines } from '../effects/speedLines.js';
import type { AmbientParticles } from '../effects/ambientParticles.js';
import type { GroundMist } from '../effects/groundMist.js';
import type { AmbientBirds } from '../effects/birds.js';
import { screenShake } from '../effects/screenShake.js';
import { updateVfx } from '../effects/vfx.js';
import * as sfxAudio from '../core/sfx/world.js';

import type { NetworkManager } from '../networking/NetworkManager.js';
import type { HUD } from '../ui/hud.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { createScene } from '../world/scene.js';
import { updateDirectionalFog } from '../world/directionalFog.js';
import type { createRenderer } from '../core/renderer.js';
import type { Terrain } from '../world/terrain.js';
import type { createEntities } from './entities.js';
import type { createCombat } from './combat.js';
import type { createDemoLifecycle } from './demoLifecycle.js';
import type { createRemotes } from './remotes.js';
import type { createWaveDirector } from './waveDirector.js';
import type { WorldState } from './worldState.js';
import { createPerfHud } from '../core/perfHud.js';
import { createFrameBudget } from '../core/frameBudget.js';
import { lastWeaponByPlayer } from './net/projectiles.js';
import { fpsWatchdog, resetAutoQuality } from './loopPerf.js';
import { createRenderScan } from './renderScan.js';
import { settings } from '../core/settings.js';
import { WeaponType } from '../../../shared/weapons.js';

const _zeroVel = new THREE.Vector3(); // shared zero for demo playback
const _sunDir = new THREE.Vector3(); // scratch — directional fog sun lookup
const _birdPosBuf: THREE.Vector3[] = []; // scratch — minimap debug blips
const _mapBlips: import('../ui/minimap.js').MinimapPlayer[] = []; // scratch — minimap player/bot blips

// ?mode=classic — solo bounce-and-shoot: balls only, no rage, no roster
const CLASSIC_MODE = urlParams.isClassic;

// Dead-checkable effect list — update each, dispose+splice the finished.
function updateDeadList<T extends { update(dt: number): void; dead: boolean; dispose(): void }>(list: T[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    list[i]!.update(dt);
    if (list[i]!.dead) { list[i]!.dispose(); list.splice(i, 1); }
  }
}

const _aliveCount = (l: { dead: boolean }[]) => { let n = 0; for (const e of l) if (!e.dead) n++; return n; };

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
   *  gate — populated once the __t2interiors group exists. */
  interiorCasters?: THREE.Mesh[];
  /** Frames rendered before the shader warmup fires — lets async content
   *  (interiors, rigs) land in the scene before compileAsync runs. */
  warmN: number;
  warmed: boolean;
}

// Per-fxJob EMA ms — 'fx' was one opaque phase over nine rotated jobs;
// the dump couldn't tell the quarks batch from a legacy list pileup.
// EMA hides the burst spikes (a 2.5ms single-frame job averages away),
// so a decaying max rides beside it and resets with each dump.
const fxJobMs = new Map<string, number>();
const fxJobMax = new Map<string, number>();
function fxJobSample(name: string, ms: number): void {
  fxJobMs.set(name, (fxJobMs.get(name) ?? 0) * 0.9 + ms * 0.1);
  if (ms > (fxJobMax.get(name) ?? 0)) fxJobMax.set(name, ms);
}
export function fxJobStats(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of fxJobMs) out[k] = +v.toFixed(2);
  for (const [k, v] of fxJobMax) out[`max:${k}`] = +v.toFixed(2);
  return out;
}
/** Clear the per-job maxes — called per dump so a spike doesn't fossilize. */
export function fxJobResetMax(): void { fxJobMax.clear(); }

// Demo bookkeeping: update recorder/player, freeze input during playback.
// Returns whether demo playback is currently paused.
function tickDemo(deps: GameLoopDeps, dt: number): boolean {
  const demoManager = deps.lazyDemoManager();
  const player = deps.lazyPlayer();
  if (demoManager) demoManager.update(dt); // zero-overhead when idle
  const shouldFreeze = demoManager?.isPlaying ?? false;
  if (shouldFreeze && !player.inputFrozen) player.freezeInput();
  else if (!shouldFreeze && player.inputFrozen) player.unfreezeInput();
  return demoManager?.isPaused ?? false;
}

// Species census for the bottom-left debug readout — in-place count,
// no per-frame filter arrays.
function censusEntities(deps: GameLoopDeps, entities: ReturnType<typeof createEntities>) {
  let balls = 0, elites = 0;
  for (const b of entities.balls) {
    if (b.dead || b.disposed) continue;
    if (b.variant === 3) elites++; else balls++;
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
      + deps.world.implosions.length + deps.world.scorches.length,
  };
}

// Fog uniforms ride the terrain shader — must sync every frame. Fog color
// follows the sun: looking sunward warms the haze, away cools it; the sky
// horizon uniform takes the same tint so fogged ground stays seamless.
function syncFog(deps: GameLoopDeps, terrain: Terrain): void {
  const fog = deps.sceneSetup.scene.fog;
  if (!(fog instanceof THREE.Fog)) return;
  _sunDir.copy(deps.sceneSetup.sun.position).normalize();
  const tinted = updateDirectionalFog(fog, deps.camera, _sunDir);
  fog.color.copy(tinted);
  deps.sceneSetup.atmosphericSky.setFogColor(tinted);
  terrain.updateFog(fog.color, fog.near, fog.far);
}

/** Stage 1 — world sim: player, terrain, entities, wave director,
 *  projectiles. Returns demoPaused for the later stages. */
interface TickFrame { dt: number; player: Player; networkManager: NetworkManager; demoManager: DemoManager | null }
const fmtBps = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB/s` : b >= 1024 ? `${(b / 1024).toFixed(1)}KB/s` : `${Math.round(b)}B/s`;
function simTick(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, f: TickFrame, terrain: Terrain): boolean {
  const { dt, player, demoManager } = f;
  player.update(dt);
  terrain.update(player.pos.x, player.pos.z);
  syncFog(deps, terrain);

  // Position send even when hidden — the server needs liveness. Runs
  // unconditionally: sends no-op while disconnected (ws?.connected()
  // guards inside), but gating the whole tick on the socket froze every
  // remote/bot indicator mid-screen for the life of a flap.
  if (!player.isDead && !demoManager?.isPlaying) {
    deps.remotes().networkTick(dt);
  }
  perf.mark('player');

  const demoPaused = tickDemo(deps, dt);
  if (demoPaused) return true;

  tickEntities(deps, perf, dt, demoManager?.isPlaying ?? false);
  return false;
}

function tickEntities(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, dt: number, demoPlaying: boolean): void {
  const entities = deps.entities;
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
  if (!demoPlaying && !deps.lazyNetworkManager().isConnected()) deps.waveDirector().update(dt);
  if (!demoPlaying) entities.updateNuggets(dt);
  deps.teamBots?.()?.update(dt);
  perf.mark('bots');
  if (!demoPlaying) deps.combat()?.updateProjectiles(dt);
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
  // (particles freeze otherwise) and its prune/cap is what keeps the
  // sim bounded — deferring it under load let `live` balloon past
  // MAX_LIVE_SYSTEMS (seen: 1201 systems → 10-24ms vfx frames).
  const v0 = performance.now();
  updateVfx(fxDt, deps.camera.position);
  fxJobSample('vfx', performance.now() - v0);
  st.fxJobs.length = 0;
  st.fxJobs.push(
    ['effects', () => deps.lazyEffects().update(fxDt)],
    ['debris', () => updateDeadList(deps.world.debrisList, fxDt)],
    ['pdebris', () => {
      const list = deps.world.playerDebrisList;
      const cam = deps.camera.position;
      // A nearby mass kill otherwise turns this one job into a 7ms+
      // spike: past the cap, remaining debris fall back to tickAge —
      // the same cheap path far debris already take.
      const t0 = performance.now();
      let i = list.length - 1;
      for (; i >= 0; i--) {
        const d = list[i]!;
        const dx = d.ox - cam.x, dy = d.oy - cam.y, dz = d.oz - cam.z;
        if (dx * dx + dy * dy + dz * dz < VFX_NEAR_SQ) {
          // Resumable shard budget — one debris can't overdraw the cap.
          d.update(fxDt, 1.5 - (performance.now() - t0));
          if (performance.now() - t0 > 1.5) { i--; break; }
        } else d.tickAge(fxDt);
        if (d.dead) { d.dispose(); list.splice(i, 1); }
      }
      for (; i >= 0; i--) {
        const d = list[i]!;
        d.tickAge(fxDt);
        if (d.dead) { d.dispose(); list.splice(i, 1); }
      }
    }],
    ['gibs', () => updateGibs(fxDt)],
    ['scorch', () => updateDeadList(deps.world.scorches, fxDt)],
    ['explosions', () => {
      const ex = deps.world.explosions;
      for (let i = 0; i <= ex.length - MAX_LIVE_EXPLOSIONS; i++) ex[i]!.dead = true;
      // Same 260m rule as the vfx sim-pause — a blast past it is sub-pixel,
      // so it ages out without paying the layer/spark buffer writes.
      const cam = deps.camera.position;
      for (let i = ex.length - 1; i >= 0; i--) {
        const e = ex[i]!;
        if (!e.dead) {
          if (e.pos.distanceToSquared(cam) < VFX_NEAR_SQ) e.update(fxDt);
          else e.tickAge(fxDt);
        }
        if (e.dead) { e.dispose(); ex.splice(i, 1); }
      }
    }],
    ['implosions', () => updateDeadList(deps.world.implosions, fxDt)],
    ['aoegiz', () => updateDeadList(deps.world.aoeGizmos, fxDt)],
  );
  if (st.fxCursor > 0) st.fxJobs.push(...st.fxJobs.splice(0, st.fxCursor));
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
  // Entity-count text is a slow-moving counter — 10Hz is plenty.
  budget.sweep('census', 100, () => hud.setEntityCounts(censusEntities(deps, entities)));
  hud.setNuggets(entities.getNuggetsCollected());
  hud.setTimer(deps.waveDirector().elapsed);
  hud.setMatchStatus(
    deps.world.matchEndsAt ? deps.world.matchEndsAt - Date.now() : null,
    deps.world.flagStates,
  );
  hud.updateDeathCountdown(deps.world.respawnMs);
  budget.sweep('minimap', 40, () => {
    // Both buffers exist only to feed updateMinimap — build them inside
    // the sweep so they refresh on the same cadence.
    deps.ambientBirds.positions(_birdPosBuf);
    // Player/bot blips — same friend-or-foe rule as the overhead markers:
    // wire team (or GameBot.team) matching localTeam = green, else red.
    // Dead and cloaked riders are dropped — no corpse pings, no cloak leak.
    _mapBlips.length = 0;
    const wirePlayers = networkManager.getPlayers();
    for (const [id, rp] of deps.world.remotePlayers) {
      if (rp.isDead || rp.isCloakHidden) continue;
      const team = (rp as { team?: string }).team ?? wirePlayers.get(id)?.team;
      _mapBlips.push({ x: rp.position.x, z: rp.position.z, friendly: !!team && team === deps.world.localTeam });
    }
    hud.updateMinimap(entities.targets, entities.nuggets, player.pos, player.yaw, _birdPosBuf, _mapBlips);
  });

  viewModel.group.visible = !demoManager?.isPlaying && !player.isDead && !player.thirdPerson && !player.isSpectating;
  const yawDelta = Math.atan2(Math.sin(player.yaw - st.lastYaw), Math.cos(player.yaw - st.lastYaw));
  viewModel.update(dt, yawDelta, player.pitch - st.lastPitch, player.vel, camera, player.shootAnimTimer > 0);
  st.lastYaw = player.yaw;
  st.lastPitch = player.pitch;
  perf.mark('viewmodel');
  deps.lazyHealthBarSystem().update(dt, networkManager.getPlayers(), deps.world.remotePlayers, entities.balls);
  perf.mark('healthbars');

  // Peripheral speed lines along the true velocity vector; demo-suppressed.
  deps.speedLines.update(fxDt, camera.position, demoManager?.isPlaying ? _zeroVel : player.vel);

  if (st.cpuLevel === 0) {
    for (const layer of deps.ambientLayers) layer.update(fxDt, camera.position, terrain);
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
    // bottom:40 — above the "⟳ files changed" badge strip (bottom:8, ~24px tall)
    // --z-br-3: reserved debug row in hud.css — hardcoding an offset here
    // is what parked the charts on top of the entity-counts row.
    dom.style.cssText = `position:fixed;bottom:var(--z-br-3);right:${20 + (2 - i) * 88}px;left:auto;top:auto;z-index:10000;display:none;`;
    document.body.appendChild(dom);
    return s;
  });
}

function wireDebugKeys(deps: GameLoopDeps, perf: ReturnType<typeof createPerfHud>, budget: ReturnType<typeof createFrameBudget>, statsPanels: ReturnType<typeof makeStatsPanels>): void {
  // window.__perf — live phase table for headless probes + manual reads;
  // the watchdog dump uses the same data for shipped logs.
  (window as unknown as { __perf: () => Record<string, number> }).__perf =
    () => ({ ...perf.snapshot(), ...budget.stats() as unknown as Record<string, number>, ...fxJobStats() });
  // window.__renderScan — staged render breakdown (scene / +shadow / full
  // pipeline / viewmodel) with per-stage calls+tris+GPU-ms. Profiling hook;
  // renders extra frames on top of the loop.
  (window as unknown as { __renderScan: unknown }).__renderScan = createRenderScan(deps);
  document.addEventListener('keydown', (e) => {
    // Alt+W — bot weapon audit: last gun each bot drew + its shot count,
    // so "do they fire real weapons" is a one-keypress read. Alt+Shift+W
    // keeps the old hard-reload hatch (F5 is flaky under pointer lock).
    if (e.altKey && e.code === 'KeyW') {
      e.preventDefault();
      if (e.shiftKey) { location.reload(); return; }
      const rows = [...lastWeaponByPlayer.entries()]
        .filter(([id]) => id.startsWith('BOT-'))
        .map(([id, r]) => ({ bot: id, weapon: WeaponType[r.wt] ?? `w${r.wt}`, shots: r.n }));
      console.table(rows.length ? rows : [{ note: 'no bot fire seen yet' }]);
      return;
    }
    if (e.code === 'Backquote') {
      e.preventDefault();
      const show = (statsPanels[0]!.dom as HTMLElement).style.display === 'none';
      for (const s of statsPanels) {
        (s.dom as HTMLElement).style.display = show ? 'block' : 'none';
      }
      perf.setVisible(show);
    }
  });
}

// Interior shadow casters distance-gated like remotes: only near-camera
// architecture darkens the map; far towers' shadows are unreadable.
// Census showed ~700 caster meshes — at a base view they were half the
// shadow pass's draw calls.
function gateInteriorCasters(deps: GameLoopDeps, st: LoopState, camera: THREE.Camera): void {
  if (!st.interiorCasters) {
    const g = deps.sceneSetup.scene.getObjectByName('__t2interiors');
    if (g) st.interiorCasters = g.children as THREE.Mesh[];
  }
  if (!st.interiorCasters) return;
  for (const m of st.interiorCasters) {
    const bs = m.geometry.boundingSphere!;
    m.castShadow = (m.userData.castR as number) > 0 &&
      bs.center.distanceToSquared(camera.position) < (90 + bs.radius) ** 2;
  }
}

// Shader warmup — programs used to compile lazily mid-frame and hitch the
// first ~10s after join (render 116-134ms measured). Once the world content
// has landed, compileAsync parallel-compiles every scene material instead
// of stalling individual draws.
function maybeWarmShaders(deps: GameLoopDeps, st: LoopState): void {
  if (st.warmed || ++st.warmN <= 60) return;
  if (!deps.sceneSetup.scene.getObjectByName('__t2interiors') && st.warmN <= 600) return;
  st.warmed = true;
  deps.rendererSetup.warmup();
}

export function createGameLoop(deps: GameLoopDeps) {
  let lastTime = 0;
  const st: LoopState = { lastYaw: 0, lastPitch: 0, lowFpsFrames: 0, lowFpsAccum: 0, lastFpsDump: 0, gpuLevel: 0, cpuLevel: 0, cpuBound: false, headroomAccum: 0, autoPixel: false, fxCursor: 0, fxJobs: [], shadowAcc: 0, renderAcc: 0, warmN: 0, warmed: false };

  // stats.js perf panels — FPS/MS/MB in a row along the bottom-right,
  // toggled with ` (backquote). stats.js only renders one panel per
  // instance, so use one per metric; panels are 80px wide + 8px gap.
  const statsPanels = makeStatsPanels();
  const perf = createPerfHud();
  // AUTO QUALITY toggle (top of SETTINGS): off freezes the ladder where it
  // is AND restores full quality, so the user isn't left on a preset they
  // never picked. No reload — ladders gate on the setting live.
  const autoqBtn = document.getElementById('autoq-toggle') as HTMLButtonElement | null;
  if (autoqBtn) {
    const label = () => { autoqBtn.textContent = settings.get('fps-autoq') ? 'AUTO QUALITY: ON' : 'AUTO QUALITY: OFF'; };
    label();
    autoqBtn.addEventListener('click', () => {
      const on = !settings.get('fps-autoq');
      settings.set('fps-autoq', on);
      if (!on) resetAutoQuality(deps, st);
      label();
    });
  }
  // FPS CAP — render skip only; sim/input keep full rAF rate. A real
  // vsync-off isn't possible in a browser, but capping buys battery on
  // chromebooks and headroom measurement on high-refresh displays.
  const FPS_CAPS = [0, 30, 60, 120];
  const capBtn = document.getElementById('fpscap-toggle') as HTMLButtonElement | null;
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
    // stats.js paints its canvas even when display:none — the panels were
    // costing ~2% of a throttled frame with the debug HUD hidden.
    if ((statsPanels[0]!.dom as HTMLElement).style.display !== 'none')
      for (const s of statsPanels) s.update();
    const rawElapsed = (time - lastTime) / 1000;
    const dt = Math.min(rawElapsed, MAX_DELTA_TIME);
    lastTime = time;
    fpsWatchdog(deps, st, budget, perf, rawElapsed, time);
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
    const demoPaused = simTick(deps, perf, frame, terrain);
    if (!demoPaused) fxTick(deps, st, budget, fxDt);
    perf.mark('fx');
    deps.remotes().updateScoreboard();

    // ?dummy debug remote — pin it in front of the camera and tick it
    const dummy = deps.world.remotePlayers.get('dummy');
    const dummyTick = deps.getDummyTick();
    if (dummy && dummyTick) { dummyTick(dt); dummy.tick(dt); }

    hudTick(deps, st, budget, perf, frame, fxDt);
    perf.mark('hud');

    // FPS cap: skip only the render call — sim/input stay full-rate.
    // Carry leftover time so the cap hits its target rate, not stutters.
    const cap = settings.get('fps-cap');
    let doRender = true;
    if (cap > 0) {
      st.renderAcc += rawElapsed;
      doRender = st.renderAcc >= 1 / cap;
      if (doRender) st.renderAcc = Math.min(st.renderAcc - 1 / cap, 1 / cap);
    }
    if (doRender) renderFrame(fxDt); // damage numbers ride fxDt — same hidden-tab decay fix
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
      if (!vm.group.visible) return;
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
    const renderer = rendererSetup.renderer;

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

    if (rendererSetup.needsComposer()) {
      rendererSetup.render(dt); // FLOYD: overlay pass (the VM draw below) runs inside
    } else {
      renderer.render(sceneSetup.scene, camera);
    }

    // Viewmodel pass — clear depth only, draw gun on top with its own FOV.
    // In FLOYD the GL canvas is hidden and this same draw is injected into
    // fsRender via the overlay hook — skip it here or it draws post-readback.
    if (viewModel.group.visible && !rendererSetup.isFloyd()) {
      vmCamera.aspect = camera.aspect;
      vmCamera.updateProjectionMatrix();
      vmCamera.quaternion.copy(camera.quaternion);
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(vmScene, vmCamera);
      renderer.autoClear = prevAutoClear;
    }

    // Damage numbers update after post-processing (bypass bloom/contrast for visibility)
    deps.damageNumberManager().update(dt, deps.camera);
  }

  return {
    start(): void { requestAnimationFrame(loop); },
  };
}
