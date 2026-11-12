// Dev-only debug wiring — extracted from main.ts (the file is size-pinned;
// this whole block only runs on dev hosts or ?debug anyway). Called once
// at boot when allowed, again on the menu DEBUG toggle (fps:set).
import type * as THREE from 'three';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { Player } from '../entities/Player.js';
import type { TeamBots } from '../game/bots/index.js';
import type { ChildLogger } from '../core/Logger.js';
import type { WorldState } from '../game/worldState.js';
import type { createEntities } from '../game/entities.js';
import type { createRemotes } from '../game/remotes.js';
import type { createRenderer } from '../core/renderer.js';
import type { createDemoLifecycle } from '../game/demoLifecycle.js';
import type { DemoManager } from '../demo/index.js';
import type { Terrain } from '../world/terrain.js';
import type { ViewModel } from '../entities/ViewModel.js';
import type { HUD } from '../ui/hud.js';
import { armTelemetry } from '../core/telemetry.js';
import { urlParams } from '../core/params.js';

export interface DevToolsCtx {
  networkManager: NetworkManager;
  player: Player;
  world: WorldState;
  entities: ReturnType<typeof createEntities>;
  terrain: Terrain;
  viewModel: ViewModel;
  demoManager: DemoManager | null;
  rendererSetup: ReturnType<typeof createRenderer>;
  demoLifecycle: ReturnType<typeof createDemoLifecycle>;
  scene: THREE.Scene;
  remotes: ReturnType<typeof createRemotes>;
  teamBots: TeamBots | null;
  logger: ChildLogger;
  hud: HUD;
}

let wired = false;

function stateDebugCtx(c: DevToolsCtx): Parameters<typeof import('../core/stateDebug.js').wireDiagHeader>[0] {
  return {
    networkManager: c.networkManager,
    getPlayer: (): Player => c.player,
    remotePlayers: c.world.remotePlayers,
    projectiles: c.world.projectiles,
    getLastSentPos: c.remotes.getLastSentPos,
    world: c.world,
    teamBots: (): TeamBots | null => c.teamBots,
    viewModel: c.viewModel,
    getScene: (): THREE.Scene<THREE.Object3DEventMap> => c.scene,
    getCamera: (): THREE.PerspectiveCamera => c.player.camera,
    netCreatures: () => [
      ...c.entities.crawlers, ...c.entities.scarabs, ...c.entities.rakks, ...c.entities.rollers,
      ...c.entities.gnats, ...c.entities.snakes, ...c.entities.banelings, ...c.entities.totems,
    ],
    netDeployables: () => c.entities.deployables.netEntries(),
    logger: c.logger,
  };
}

export async function wireDebugTools(c: DevToolsCtx): Promise<void> {
  if (wired) {return;}
  wired = true;
  const { wireStateDebug } = await import('../core/stateDebug.js');
  wireStateDebug(stateDebugCtx(c));
  // Headless/probe hook — the puppeteer scripts in headless-test drive off
  // this (spawn PlayerModels, read player.pos, aim the camera).
  window.__test = {
    player: c.player, scene: c.scene, entities: c.entities, world: c.world,
    terrain: c.terrain, viewModel: c.viewModel,
    networkManager: c.networkManager, demoManager: c.demoManager, hud: c.hud,
    rendererSetup: c.rendererSetup, demoLifecycle: c.demoLifecycle,
    teamBots: c.teamBots,
    chatSink: (await import('../game/chat.js')).chatSink,
    parity: (await import('../game/parity.js')).parityProbes,
  };
  // .rec captures (gauntlet --record / pvptest record.ts) replay through
  // the live dispatch as gameplay: __playRec('/hunt.rec', 1.5)
  window.__playRec = async (src, speed): Promise<() => void> =>
    (await import('./recPlayer.js')).playRec(c.networkManager, src, speed);
  armTelemetry();
  // ?autopilot — the shared BotBrain steers the local player through the
  // real input fields, so a soak window plays itself. Same inputs a
  // human holds — prediction + wire intents are unchanged.
  if (urlParams.has('autopilot')) {
    const { startBotPilot } = await import('./botPilot.js');
    window.__botpilot = { stop: startBotPilot({ player: c.player, networkManager: c.networkManager, world: c.world, terrain: c.terrain, entities: c.entities }) };
  }
}
