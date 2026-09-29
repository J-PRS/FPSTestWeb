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
import Logger from '../core/Logger.js';
import { createPerfHud } from '../core/perfHud.js';
import { createFrameBudget } from '../core/frameBudget.js';

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
export function createGameLoop(deps: GameLoopDeps) {
  let lastTime = 0;
  let lastPlayerYaw = 0;
  let lastPlayerPitch = 0;

  // stats.js perf panels — FPS/MS/MB in a row along the bottom-right,
  // toggled with ` (backquote). stats.js only renders one panel per
  // instance, so use one per metric; panels are 80px wide + 8px gap.
  const statsPanels = [0, 1, 2].map((panel, i) => {
    const s = new Stats();
    s.showPanel(panel);
    const dom = s.dom as HTMLElement;
    // bottom:40 — above the "⟳ files changed" badge strip (bottom:8, ~24px tall)
    dom.style.cssText = `position:fixed;bottom:40px;right:${20 + (2 - i) * 88}px;left:auto;top:auto;z-index:10000;display:none;`;
    document.body.appendChild(dom);
    return s;
  });
  const perf = createPerfHud();
  // Frame-budget runner — ms-quota chunking + phased sweeps for work
  // that's expensive but not frame-critical. First pilot: the minimap
  // sweep at 25Hz (full-rate blip redraw was invisible anyway).
  const budget = createFrameBudget();
  // window.__perf — live phase table for headless probes + manual reads;
  // the watchdog dump uses the same data for shipped logs.
  (window as unknown as { __perf: () => Record<string, number> }).__perf =
    () => ({ ...perf.snapshot(), ...budget.stats() as unknown as Record<string, number> });
  document.addEventListener('keydown', (e) => {
    // Alt+W — hard reload escape hatch. F5 is flaky under pointer lock +
    // dev HMR; this survives both (keydown still fires while locked).
    if (e.altKey && e.code === 'KeyW') {
      e.preventDefault();
      location.reload();
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

  // FPS watchdog — sustained <40fps for >10 consecutive frames fires a
  // one-shot stats dump (ships to logs/client.log via the WARN+ pipeline),
  // throttled to once per 10s. Uses rawElapsed, not clamped dt, and skips
  // hidden tabs (rAF throttling ≠ real perf).
  let lowFpsFrames = 0;
  let lowFpsAccum = 0;
  let lastFpsDump = 0;
  function fpsWatchdog(rawElapsed: number, now: number): void {
    if (document.hidden || rawElapsed <= 0) return;
    if (1 / rawElapsed < 40) { lowFpsFrames++; lowFpsAccum += rawElapsed; }
    else { lowFpsFrames = 0; lowFpsAccum = 0; }
    if (lowFpsFrames > 10 && now - lastFpsDump > 10_000) {
      lastFpsDump = now;
      const player = deps.lazyPlayer();
      const nm = deps.lazyNetworkManager();
      const info = deps.rendererSetup.renderer.info;
      const entities = deps.entities;
      Logger.warn('LOW FPS sustained — perf dump', {
        avgFps: Math.round(lowFpsFrames / lowFpsAccum),
        frames: lowFpsFrames,
        pos: { x: +player.pos.x.toFixed(1), y: +player.pos.y.toFixed(1), z: +player.pos.z.toFixed(1) },
        speed: +player.vel.length().toFixed(1),
        dead: player.isDead,
        demo: deps.lazyDemoManager()?.isPlaying ?? false,
        targets: entities.targets.length,
        balls: entities.balls.filter(b => !b.dead && !b.disposed).length,
        nuggets: entities.nuggets.length,
        remotes: deps.world.remotePlayers.size,
        projectiles: deps.world.projectiles.length,
        explosions: deps.world.explosions.length,
        debris: deps.world.debrisList.length + deps.world.playerDebrisList.length,
        scorches: deps.world.scorches.length,
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        phases: perf.snapshot(),
        budget: budget.stats(),
        ping: nm?.getPing?.(),
        packetLoss: nm?.getPacketLoss?.(),
        heapMB: (performance as { memory?: { usedJSHeapSize: number } }).memory
          ? Math.round((performance as { memory?: { usedJSHeapSize: number } }).memory!.usedJSHeapSize / 1048576)
          : undefined,
      });
      lowFpsFrames = 0; lowFpsAccum = 0;
    }
  }

  // Demo bookkeeping: update recorder/player, freeze input during playback.
  // Returns whether demo playback is currently paused.
  function tickDemo(dt: number): boolean {
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
  function censusEntities(entities: ReturnType<typeof createEntities>) {
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
  function syncFog(terrain: Terrain): void {
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
  function simTick(dt: number, player: Player, terrain: Terrain, networkManager: NetworkManager, demoManager: DemoManager | null): boolean {
    player.update(dt);
    terrain.update(player.pos.x, player.pos.z);
    syncFog(terrain);

    // Position send even when hidden — the server needs liveness.
    if (networkManager.isConnected() && !player.isDead && !demoManager?.isPlaying) {
      deps.remotes().networkTick(dt);
    }
    perf.mark('player');

    const demoPaused = tickDemo(dt);
    if (demoPaused) return true;

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
    if (!demoManager?.isPlaying) deps.waveDirector().update(dt);
    if (!demoManager?.isPlaying) entities.updateNuggets(dt);
    deps.teamBots?.()?.update(dt);
    perf.mark('bots');
    if (!demoManager?.isPlaying) deps.combat()?.updateProjectiles(dt);
    deps.demoLifecycle().updatePlaybackProjectiles(dt);
    perf.mark('proj');
    return false;
  }

  /** Stage 2 — transient VFX on wall-clock fxDt so they decay while the
   *  tab is hidden instead of stacking into an overdraw bomb. Profiled the
   *  hottest stage under fire (~5ms in a debris storm): the list updates
   *  run as budgeted jobs under an ms cap, rotated each frame so sustained
   *  load starves every list evenly instead of tail-dropping the last two.
   *  Skipped frames are absorbed by the dt-based decay. */
  const FX_MS_CAP = 1.2;
  const _fxJobs: (() => void)[] = [];
  let _fxCursor = 0;
  function fxTick(fxDt: number): void {
    _fxJobs.length = 0;
    _fxJobs.push(
      () => deps.lazyEffects().update(fxDt),
      () => updateDeadList(deps.world.debrisList, fxDt),
      () => updateDeadList(deps.world.playerDebrisList, fxDt),
      () => updateGibs(fxDt),
      () => updateDeadList(deps.world.scorches, fxDt),
      () => updateDeadList(deps.world.explosions, fxDt),
      () => updateDeadList(deps.world.implosions, fxDt),
      () => updateDeadList(deps.world.aoeGizmos, fxDt),
    );
    if (_fxCursor > 0) _fxJobs.push(..._fxJobs.splice(0, _fxCursor));
    _fxCursor = (_fxCursor + 1) % _fxJobs.length;
    budget.each('fxdecay', _fxJobs, FX_MS_CAP, (job) => job());
    // Deferred lists resume on their own next frame — nothing carries over.
    _fxJobs.length = 0;
  }

  /** Stage 3 — HUD + viewmodel + ambient/atmosphere, then render. */
  function hudTick(dt: number, fxDt: number, player: Player, networkManager: NetworkManager, demoManager: DemoManager | null): void {
    const { camera, sceneSetup, entities } = deps;
    const hud = deps.lazyHud();
    const viewModel = deps.lazyViewModel();
    const terrain = deps.lazyTerrain();

    hud.update(dt, player, networkManager.getPing(), networkManager.getPacketLoss(), networkManager.getJitter());
    // Entity-count text is a slow-moving counter — 10Hz is plenty.
    budget.sweep('census', 100, () => hud.setEntityCounts(censusEntities(entities)));
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
    const yawDelta = Math.atan2(Math.sin(player.yaw - lastPlayerYaw), Math.cos(player.yaw - lastPlayerYaw));
    viewModel.update(dt, yawDelta, player.pitch - lastPlayerPitch, player.vel, camera);
    lastPlayerYaw = player.yaw;
    lastPlayerPitch = player.pitch;
    perf.mark('viewmodel');
    deps.lazyHealthBarSystem().update(dt, networkManager.getPlayers(), deps.world.remotePlayers, entities.balls);
    perf.mark('healthbars');

    // Peripheral speed lines along the true velocity vector; demo-suppressed.
    deps.speedLines.update(fxDt, camera.position, demoManager?.isPlaying ? _zeroVel : player.vel);

    for (const layer of deps.ambientLayers) layer.update(fxDt, camera.position, terrain);
    deps.groundMist().update(fxDt, camera.position);
    deps.ambientBirds.update(fxDt, player.pos, terrain, player.isDead);
    perf.mark('ambient');

    sceneSetup.update(dt);
    sceneSetup.atmosphericSky.followCamera(camera.position);

    // Shake composes after player.update's camera write; the LG beam weld
    // is last — it needs the swayed viewmodel AND the post-shake camera or
    // fast moves leave the bolt a frame stale.
    screenShake.update(dt, camera);
    deps.combat()?.updateBeamVisual();
    sfxAudio.updateAudio(dt, player, camera);
    perf.mark('scene');
  }

  function loop(time: number): void {
    requestAnimationFrame(loop);
    for (const s of statsPanels) s.update();
    const rawElapsed = (time - lastTime) / 1000;
    const dt = Math.min(rawElapsed, MAX_DELTA_TIME);
    lastTime = time;
    fpsWatchdog(rawElapsed, time);
    perf.begin();

    // Hidden tabs get ~1 rAF/sec — dt clamps to 0.05 so game logic runs in
    // slow motion, but cosmetic VFX must still expire in real time or they
    // stack into an overdraw bomb while you're AFK. fxDt = wall-clock
    // (clamped 2s) when hidden; normal dt when visible.
    const fxDt = document.hidden ? Math.min(rawElapsed, 2) : dt;

    const player = deps.lazyPlayer();
    const terrain = deps.lazyTerrain();
    const networkManager = deps.lazyNetworkManager();
    const demoManager = deps.lazyDemoManager();

    const demoPaused = simTick(dt, player, terrain, networkManager, demoManager);
    if (!demoPaused) fxTick(fxDt);
    perf.mark('fx');
    deps.remotes().updateScoreboard();

    // ?dummy debug remote — pin it in front of the camera and tick it
    const dummy = deps.world.remotePlayers.get('dummy');
    const dummyTick = deps.getDummyTick();
    if (dummy && dummyTick) { dummyTick(dt); dummy.tick(dt); }

    hudTick(dt, fxDt, player, networkManager, demoManager);
    perf.mark('hud');

    renderFrame(fxDt); // damage numbers ride fxDt — same hidden-tab decay fix
    perf.end(deps.rendererSetup.renderer, () => `tgt ${deps.entities.targets.length} rem ${deps.world.remotePlayers.size}`);
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
    deps.damageNumberManager().update(dt);
  }

  return {
    start(): void { requestAnimationFrame(loop); },
  };
}
