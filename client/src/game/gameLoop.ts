import * as THREE from 'three';
import Stats from 'stats.js';

import { MAX_DELTA_TIME } from '../core/config.js';
import type { DemoManager } from '../demo/index.js';
import type { Player } from '../entities/Player.js';
import type { ViewModel } from '../entities/ViewModel.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { EffectsManager } from '../effects/effects.js';
import type { SpeedLines } from '../effects/speedLines.js';
import { screenShake } from '../effects/screenShake.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { HUD } from '../ui/hud.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { createScene } from '../world/scene.js';
import type { createRenderer } from '../core/renderer.js';
import type { Terrain } from '../world/terrain.js';
import type { createEntities } from './entities.js';
import type { createCombat } from './combat.js';
import type { createDemoLifecycle } from './demoLifecycle.js';
import type { createRemotes } from './remotes.js';
import type { WorldState } from './worldState.js';

const _zeroVel = new THREE.Vector3(); // shared zero for demo playback

export interface GameLoopDeps {
  camera: THREE.PerspectiveCamera;
  sceneSetup: ReturnType<typeof createScene>;
  rendererSetup: ReturnType<typeof createRenderer>;
  terrain: () => Terrain;
  player: () => Player;
  viewModel: () => ViewModel;
  vmScene: () => THREE.Scene;
  vmCamera: () => THREE.PerspectiveCamera;
  hud: () => HUD;
  healthBarSystem: () => HealthBarSystem;
  damageNumberManager: () => DamageNumberManager;
  networkManager: () => NetworkManager;
  demoManager: () => DemoManager | null;
  effects: () => EffectsManager;
  speedLines: SpeedLines;
  entities: ReturnType<typeof createEntities>;
  combat: () => ReturnType<typeof createCombat>;
  remotes: () => ReturnType<typeof createRemotes>;
  demoLifecycle: () => ReturnType<typeof createDemoLifecycle>;
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

  // stats.js perf panel — bottom right, toggled with ` (backquote)
  const stats = new Stats();
  stats.showPanel(0);
  const statsDom = stats.dom as HTMLElement;
  statsDom.style.cssText = 'position:fixed;bottom:56px;right:20px;left:auto;top:auto;z-index:10000;display:none;';
  document.body.appendChild(statsDom);
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') {
      e.preventDefault();
      statsDom.style.display = statsDom.style.display === 'none' ? 'block' : 'none';
    }
  });

  // Update a list of dead-checkable effect/entity objects, disposing finished ones
  function updateDeadList<T extends { update(dt: number): void; dead: boolean; dispose(): void }>(list: T[], dt: number): void {
    for (let i = list.length - 1; i >= 0; i--) {
      list[i]!.update(dt);
      if (list[i]!.dead) { list[i]!.dispose(); list.splice(i, 1); }
    }
  }

  // Demo bookkeeping: update recorder/player, freeze input during playback.
  // Returns whether demo playback is currently paused.
  function tickDemo(dt: number): boolean {
    const demoManager = deps.demoManager();
    const player = deps.player();
    if (demoManager) demoManager.update(dt); // zero-overhead when idle
    const shouldFreeze = demoManager?.isPlaying ?? false;
    if (shouldFreeze && !player.inputFrozen) player.freezeInput();
    else if (!shouldFreeze && player.inputFrozen) player.unfreezeInput();
    return demoManager?.isPaused ?? false;
  }

  function loop(time: number): void {
    requestAnimationFrame(loop);
    stats.update();
    const dt = Math.min((time - lastTime) / 1000, MAX_DELTA_TIME);
    lastTime = time;

    const { camera, sceneSetup, entities } = deps;
    const { scene } = sceneSetup;
    const player = deps.player();
    const terrain = deps.terrain();
    const networkManager = deps.networkManager();
    const demoManager = deps.demoManager();
    const viewModel = deps.viewModel();
    const hud = deps.hud();

    // Update player physics even when tab is hidden (to keep position changing)
    player.update(dt);
    terrain.update(player.pos.x, player.pos.z);

    // Send position to server if connected (even when tab is hidden)
    // Don't send position updates while dead or during demo playback
    if (networkManager && networkManager.isConnected() && !player.isDead && !demoManager?.isPlaying) {
      deps.remotes().networkTick(dt);
    }

    // Sync fog uniforms to terrain shader (all clipmap levels)
    if (scene.fog instanceof THREE.Fog) {
      terrain.updateFog(scene.fog.color, scene.fog.near, scene.fog.far);
    }
    const demoPaused = tickDemo(dt);
    if (!demoPaused) entities.updateBalls(dt);
    if (!demoPaused) entities.updateCrawlers(dt);
    if (!demoPaused) entities.updateTurrets(dt);
    if (!demoPaused) entities.updateRollers(dt);
    if (!demoManager?.isPlaying) entities.updateNuggets(dt);
    if (!demoManager?.isPlaying) {
      deps.combat()?.updateProjectiles(dt);
    }

    // Update playback projectiles (deterministic reconstruction from events)
    if (!demoPaused) deps.demoLifecycle().updatePlaybackProjectiles(dt);

    if (!demoPaused) {
      deps.effects().update(dt);
      updateDeadList(deps.world.debrisList, dt);
      updateDeadList(deps.world.playerDebrisList, dt);
      updateDeadList(deps.world.scorches, dt);
      updateDeadList(deps.world.explosions, dt);
      updateDeadList(deps.world.implosions, dt);
    }
    deps.remotes().updateScoreboard();

    // Debug dummy remote player (?dummy) — pin it in front of the camera and tick it
    const dummy = deps.world.remotePlayers.get('dummy');
    const dummyTick = deps.getDummyTick();
    if (dummy && dummyTick) {
      dummyTick(dt);
      dummy.tick(dt);
    }

    hud.update(dt, player, networkManager.getPing(), networkManager.getPacketLoss(), networkManager.getJitter());
    hud.setBallCount(entities.balls.filter(b => !b.dead && !b.disposed).length);
    hud.setNuggets(entities.getNuggetsCollected());
    viewModel.group.visible = !demoManager?.isPlaying && !player.isDead;
    const yawDelta = Math.atan2(Math.sin(player.yaw - lastPlayerYaw), Math.cos(player.yaw - lastPlayerYaw));
    viewModel.update(dt, yawDelta, player.pitch - lastPlayerPitch, player.vel, camera);
    lastPlayerYaw = player.yaw;
    lastPlayerPitch = player.pitch;
    deps.healthBarSystem().update(dt, networkManager.getPlayers(), deps.world.remotePlayers, entities.balls);

    // Peripheral speed lines — world-space streaks along the true velocity
    // vector; suppressed during demo playback
    deps.speedLines.update(dt, camera.position, demoManager?.isPlaying ? _zeroVel : player.vel);

    // Update atmospheric effects
    sceneSetup.update(dt);
    sceneSetup.atmosphericSky.followCamera(camera.position);

    // Explosion screen shake — applied after player.update's camera lookAt
    // so it composes as a small rotational jitter on top
    screenShake.update(dt, camera);

    renderFrame(dt);
  }

  function renderFrame(dt: number): void {
    const { camera, rendererSetup, sceneSetup } = deps;
    const viewModel = deps.viewModel();
    const vmCamera = deps.vmCamera();
    const vmScene = deps.vmScene();
    const renderer = rendererSetup.renderer;

    if (rendererSetup.needsComposer()) {
      rendererSetup.render(dt);
    } else {
      renderer.render(sceneSetup.scene, camera);
    }

    // Viewmodel pass — clear depth only, draw gun on top with its own FOV
    if (viewModel.group.visible) {
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
