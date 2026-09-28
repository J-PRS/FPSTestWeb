import * as THREE from 'three';

import {
  CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR,
  FOG_COLOR, setBallEnrage,
} from './core/config.js';

import Logger, { ChildLogger } from './core/Logger.js';
import { urlParams } from './core/params.js';
import { watchDeployVersion } from './core/deployWatch.js';
import { createRenderer } from './core/renderer.js';
import * as sfx from './core/sfx.js';

import { DemoManager } from './demo/index.js';
import { playerProviders } from './demo/playerProviders.js';

import { Player } from './entities/Player.js';
import { ViewModel } from './entities/ViewModel.js';

import { DamageNumberManager } from './effects/damageNumbers.js';
import { EffectsManager } from './effects/effects.js';
import { SpeedLines } from './effects/speedLines.js';
import { AmbientParticles } from './effects/ambientParticles.js';
import { GroundMist } from './effects/groundMist.js';
import { AmbientBirds } from './effects/birds.js';

import { resolveServerEndpoints } from './networking/endpoints.js';
import { NetworkManager } from './networking/NetworkManager.js';
import { connectServer } from './networking/connectServer.js';

import { CoolShotsPanel } from './ui/CoolShotsPanel.js';
import { FragMessages } from './ui/FragMessages.js';
import { HealthBarSystem } from './ui/HealthBarSystem.js';
import { HUD } from './ui/hud.js';
import { wireOverlayInput } from './ui/overlayInput.js';

import { applyDebugHooks } from './game/debugHooks.js';
import { createWorldState } from './game/worldState.js';
import { createCombat } from './game/combat.js';
import { TeamBots } from './game/bots.js';
import { wirePlayerHooks } from './game/playerHooks.js';
import { createWaveDirector } from './game/waveDirector.js';
import { createDemoLifecycle } from './game/demoLifecycle.js';
import { createEntities } from './game/entities.js';
import { createGameLoop } from './game/gameLoop.js';
import { wireNetworkHandlers } from './game/netHandlers.js';
import { createRemotes } from './game/remotes.js';
import { ExplosionTracker } from './utils/ExplosionTracker.js';
import { setupInputTracking } from './utils/InputTracking.js';
import { LoadProfiler } from './utils/profiling.js';

import { createScene } from './world/scene.js';
import { createViewModelScene } from './world/viewmodelScene.js';
import { loadHeightmap, Terrain } from './world/terrain.js';
import { initSwarms } from './entities/swarms.js';
import { crawlerParts } from './entities/Crawler.js';
import { scarabParts } from './entities/Scarab.js';
import { grubParts } from './entities/Grub.js';
import { snakeParts } from './entities/Snake.js';
import { gnatParts } from './entities/Gnat.js';
import { rollerParts } from './entities/Roller.js';
import { seekerParts } from './entities/Seeker.js';
import { rakkParts } from './entities/Rakk.js';
import { mineParts } from './entities/Mine.js';
import { overlordParts } from './entities/Overlord.js';
import { banelingParts } from './entities/Baneling.js';
import { totemParts } from './entities/Totem.js';
import { turretterParts, type Bolt } from './entities/Turretter.js';
import { ballParts } from './entities/balls.js';
import { weedParts } from './entities/Tumbleweed.js';

const logger = new ChildLogger('Main');

// ---- Load Time Profiling ----
const profiler = new LoadProfiler();

// ---- Camera ----
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);

// ---- Scene ----
const sceneSetup = createScene();
const { scene, sun } = sceneSetup;

// World-space speed lines — streak quads spawn around the camera along
// the actual velocity vector; flying through them gives real relative motion
const speedLines = new SpeedLines(scene);

// Ambient particle layers — one Points cloud each; motes respawn in a
// sphere around the camera so the world always feels inhabited.
const ambientLayers = [
  new AmbientParticles(scene, 'dust'),
  new AmbientParticles(scene, 'embers'),
  new AmbientParticles(scene, 'ash'),
];
let groundMist: GroundMist; // needs terrain — created in init()
const ambientBirds = new AmbientBirds(scene); // kettle of buzzards on a thermal

// ---- Renderer ----
const rendererSetup = createRenderer(camera, scene);
const { renderer } = rendererSetup;
renderer.setClearColor(FOG_COLOR);

// ---- Game state ----
let demoManager: DemoManager | null = null;
let terrain: Terrain;
let player: Player;
let viewModel: ViewModel;
let vmSetup: ReturnType<typeof createViewModelScene>;
let hud: HUD;
let healthBarSystem: HealthBarSystem;
let damageNumberManager: DamageNumberManager;
let networkManager: NetworkManager;
// All shared mutable entity collections live in world — see game/worldState.ts
const world = createWorldState();
const remotePlayers = world.remotePlayers;
const _blinkDir = new THREE.Vector3(); // scratch for the blink FX handler
let dummyUpdate: ((dt: number) => void) | null = null; // ?dummy debug hook
let effects: EffectsManager;

// ---- Input tracking ----
const inputTracking = setupInputTracking(logger);

// ---- Explosion tracking ----
const explosionTracker = new ExplosionTracker();

// ---- Score display ----
const fragMessages = new FragMessages();

// ---- Combat pipeline (fire handlers, projectile updates, impact/force) ----
let combat: ReturnType<typeof createCombat>;
let teamBots: TeamBots | null = null; // ?mode=nuggets

// ---- Remote player lifecycle (game/remotes.ts); created in init() ----
let remotes: ReturnType<typeof createRemotes>;

// ---- Demo playback lifecycle (game/demoLifecycle.ts); created in init() ----
let demoLifecycle: ReturnType<typeof createDemoLifecycle>;

// ---- Ambient entities: balls/crawlers/turretters/rollers/nuggets ----
let entities: ReturnType<typeof createEntities>;
let waveDirector: ReturnType<typeof createWaveDirector>;

// ---- Frame loop + render pass (game/gameLoop.ts); created in init() ----
let gameLoop: ReturnType<typeof createGameLoop>;

// ---- Boot ----
const serverEndpoints = resolveServerEndpoints();

async function init(): Promise<void> {
  profiler.markTime('initStart');
  watchDeployVersion();
  await loadHeightmap('/assets/heightmaps/test_vertex.png');
  profiler.markTime('heightmapLoaded');

  terrain = new Terrain(scene, sun.position.clone().normalize());
  profiler.markTime('terrainCreated');

  // Instanced enemy rendering — one draw call per species-part. Species
  // register their part tables here; slots alloc lazily on first spawn.
  initSwarms(scene, terrain, {
    crawler: { parts: crawlerParts, capacity: 512 },
    scarab: { parts: scarabParts, capacity: 512 },
    grub: { parts: grubParts, capacity: 256 },
    snake: { parts: snakeParts, capacity: 256 },
    gnat: { parts: gnatParts, capacity: 256 },
    roller: { parts: rollerParts, capacity: 256 },
    seeker: { parts: seekerParts, capacity: 256 },
    rakk: { parts: rakkParts, capacity: 256 },
    mine: { parts: mineParts, capacity: 512 },
    overlord: { parts: overlordParts, capacity: 64 },
    baneling: { parts: banelingParts, capacity: 128 },
    totem: { parts: totemParts, capacity: 64 },
    turretter: { parts: turretterParts, capacity: 64 },
    ball: { parts: ballParts, capacity: 512 },
    tumbleweed: { parts: weedParts, capacity: 64 },
  });

  effects = new EffectsManager(scene);
  effects.setTerrain(terrain);
  groundMist = new GroundMist(scene, terrain); // valley fog banks
  profiler.markTime('effectsCreated');

  player = new Player(terrain, camera, scene);

  vmSetup = createViewModelScene(camera.aspect);
  viewModel = vmSetup.viewModel;

  entities = createEntities({
    scene,
    lazyTerrain: () => terrain,
    camera,
    lazyPlayer: () => player,
    lazyEffects: () => effects,
    lazyHud: () => hud,
    lazyNetworkManager: () => networkManager,
    lazyDemoManager: () => demoManager,
    lazyViewModel: () => viewModel,
    logger,
    world,
    updateBallsPlayback: (dt) => demoLifecycle.updateBallsPlayback(dt),
    // Team mode sweeps gems toward whoever's nearest — set once bots spawn.
    nuggetCollectors: () => teamBots?.collectors() ?? [],
    onNuggetCollect: (id) => teamBots?.collect(id),
    lazyCombat: () => combat,
    deployEnemyBots: () => teamBots?.enemyBotsForLocal() ?? [],
    deployDamageBot: (id, dmg, from) => teamBots?.hit(id, dmg, from, 'local') ?? false,
  });

  // Hybrid wave director — scripted beats + a credit pool spent on an
  // unlocking roster. Lives beside entities, drives its spawn fns.
  waveDirector = createWaveDirector({ entities, lazyPlayer: () => player, lazyTerrain: () => terrain, logger });

  combat = createCombat({
    lazyScene: () => scene,
    lazyTerrain: () => terrain,
    lazyCamera: () => camera,
    lazyPlayer: () => player,
    lazyViewModel: () => viewModel,
    lazyDemoManager: () => demoManager,
    lazyNetworkManager: () => networkManager,
    lazyEffects: () => effects,
    lazyHud: () => hud,
    lazyHealthBarSystem: () => healthBarSystem,
    lazyDamageNumbers: () => damageNumberManager,
    fragMessages,
    inputTracking,
    explosionTracker,
    logger,
    world,
    turretBolts: () => entities.turretBolts(),
    consumeBolt: (bolt) => entities.consumeBolt(bolt as Bolt),
    cookBoltsNear: (pos, r) => entities.cookBoltsNear(pos, r),
    reportTargetDamage: (t, dmg) => entities.reportTargetDamage(t, dmg),
    botHit: (id, dmg, fromPos) => teamBots?.hit(id, dmg, fromPos) ?? false,
    onCreatureKilled: () => teamBots?.creatureKilled('local'),
    balls: entities.balls,
    targets: entities.targets,
    nuggets: entities.nuggets,
  });
  // Buzzards join the shootable world — they fly through the shared targets
  // surface so projectiles/blasts hit them. One shot aggros the WHOLE flock
  // into a dive-bomb: 200hp each, a peck that takes half a health bar.
  // Don't shoot the wildlife.
  entities.targets.push(...ambientBirds.targets);
  ambientBirds.onPeck = (pos) => {
    if (player.isDead) return;
    player.lastDamageSource = 'pecked to death by a buzzard';
    player.applyKnockback(pos, 18);
    networkManager?.sendEnvironmentDamage(45);
    hud?.showDamage(pos, 45);
    sfx.playerHurt();
  };

  wirePlayerHooks({ player, combat, effects, viewModel, speedLines });
  // Spectator fly: strip the combat HUD, leave only a "SPECTATING" hint
  player.onSpectate = (on) => {
    if (on) { hud.hide(); hud.setSpectatorHint(true); }
    // Died mid-flight: the death path owns the HUD — don't resurface it
    else { hud.setSpectatorHint(false); if (!player.isDead) hud.show(); }
  };
  player.onCloak = (on) => { hud.setCloak(on); viewModel.setGhost(on); };
  // Shield: HUD chip + cyan vignette, viewmodel charge glow, synth cues.
  player.onShield = (on) => {
    hud.setShield(on);
    viewModel.setShield(on);
    if (on) sfx.shieldOn(); else sfx.shieldBreak();
  };
  player.onMend = (on) => {
    hud.setMend(on);
    viewModel.setMend(on);
    if (on) sfx.mendOn(); else sfx.mendOff();
  };
  player.onDeploy = () => entities.deployables.deploy();
  profiler.markTime('playerCreated');

  // Offline death path — the server's kill+respawn round-trip replicated
  // locally. Shared by bot frags and creature/environment damage.
  const killLocal = (source: string) => {
    if (player.isDead) return;
    player.isDead = true;
    player.health = 0;
    hud.hide();
    hud.setDeathOverlay(true);
    fragMessages.show(`YOU DIED\n${source}`);
    setTimeout(() => {
      player.isDead = false;
      player.health = 100;
      player.lastDamageSource = '';
      player.vel.set(0, 0, 0);
      const a = Math.random() * Math.PI * 2;
      player.pos.set(Math.cos(a) * 40, terrain.getHeight(Math.cos(a) * 40, Math.sin(a) * 40) + 2, Math.sin(a) * 40);
      player.syncMovement();
      player.markTeleport();
      hud.show();
      hud.setDeathOverlay(false);
    }, 3000);
  };
  // ?mode=nuggets|ctf|dm — offline-vs-bots modes. Bots live in
  // world.remotePlayers so creatures hunt them and projectiles hit them
  // like real players.
  const mode = urlParams.mode;
  // ?mode=classic — the original solo ruleset: bouncy balls only, lost balls
  // teleport back instead of raging (enrage was layered on top later)
  const classicMode = mode === 'classic';
  if (classicMode) setBallEnrage(false);
  if (mode === 'nuggets' || mode === 'ctf' || mode === 'dm') {
    teamBots = new TeamBots(
      {
        lazyPlayer: () => player,
        lazyTerrain: () => terrain,
        lazyEffects: () => effects,
        lazyHud: () => hud,
        lazyHealthBarSystem: () => healthBarSystem,
        lazyNetworkManager: () => networkManager,
        lazyDemoManager: () => demoManager,
        lazyScene: () => scene,
        logger,
        world,
        targets: entities.targets,
      },
      {
        dropNuggets: (pos, n, vel) => entities.spawnNuggetsAt(pos, n, vel),
        localPlayerKilled: (killerName) => killLocal(`fragged by ${killerName}`),
        remoteKillFeed: (text) => fragMessages.show(text),
        nearestNugget: (pos, maxDist) => {
          let best: typeof entities.nuggets[0] | null = null;
          let bd = maxDist * maxDist;
          for (const n of entities.nuggets) {
            if (n.collected || n.dead) continue;
            const d = n.pos.distanceToSquared(pos);
            if (d < bd) { bd = d; best = n; }
          }
          return best;
        },
        nearestCreature: (pos, maxDist) => {
          let best = null;
          let bd = maxDist * maxDist;
          for (const t of entities.targets) {
            if (t.dead || t.scoreless) continue;
            const d = t.pos.distanceToSquared(pos);
            if (d < bd) { bd = d; best = t; }
          }
          return best;
        },
        damageCreature: (id, dmg) => {
          const t = entities.targets.find(x => x.id === id);
          if (!t || t.dead) return false;
          return combat.hitTargetLocal(t, dmg); // same pipeline as a projectile hit
        },
      },
      'alpha',
      mode === 'dm' ? { alpha: 5, bravo: 4 } : { alpha: 4, bravo: 5 },
      mode,
    );
  }

  // ?yaw/?pitch/?dummy headless-screenshot hooks — see game/debugHooks.ts
  dummyUpdate = applyDebugHooks({ scene, player, terrain, remotePlayers, logger });

  // Initialize networking — NetworkManager owns the WebSocket transport
  networkManager = new NetworkManager();
  profiler.markTime('networkInit');
  player.onNetworkJump = (pos) => networkManager.sendJump(pos);
  player.onNetworkJetpack = (pos) => networkManager.sendJetpack(pos);
  player.onNetworkInput = (input, rotation) => networkManager.sendInputMove(input, rotation);

  // No server? Damage/heal claims resolve here — same clamps the server
  // applies (40 max env hit, 25 max heal) so offline can't cheat easier.
  networkManager.localAuthority = {
    envDamage: (amount) => {
      const dmg = Math.min(40, Math.max(1, Math.round(amount)));
      if (player.isDead) return;
      player.health = Math.max(0, player.health - dmg);
      player.lastDamageSource = 'the wilderness';
      hud.showDamage(player.pos, dmg);
      sfx.playerHurt();
      if (player.health <= 0) { teamBots?.localDied(); killLocal('killed by the wilderness'); }
    },
    heal: (amount) => {
      player.health = Math.min(100, player.health + Math.min(25, Math.max(1, Math.round(amount))));
    },
  };

  // Initialize demo system with player/input data providers
  demoManager = new DemoManager();
  const httpUrl = (await serverEndpoints).httpUrl;
  Logger.initShipping(httpUrl); // WARN+ lines stream to logs/client.log
  demoManager.setServerUrl(httpUrl);
  const { playerData, inputData } = playerProviders(player);
  demoManager.setDataProviders(playerData, inputData);

  // Wire cool shots panel
  new CoolShotsPanel({
    demoManager,
    overlay,
    requestLock,
  });

  // Demo playback lifecycle: owns playback registries + all onPlayback* handlers
  demoLifecycle = createDemoLifecycle({
    lazyScene: () => scene,
    lazyTerrain: () => terrain,
    lazyCamera: () => camera,
    lazyPlayer: () => player,
    lazyDemoManager: () => demoManager,
    damageNumberManager: () => damageNumberManager,
    fragMessages: () => fragMessages,
    lazyHud: () => hud,
    balls: entities.balls,
    targets: entities.targets,
    crawlers: entities.crawlers,
    turrets: entities.turrets,
    rollers: entities.rollers,
    seekers: entities.seekers,
    overlords: entities.overlords,
    mines: entities.mines,
    totems: entities.totems,
    rakks: entities.rakks,
    world,
    overlay,
    rendererCanvas: renderer.domElement,
  });
  demoLifecycle.wireDemoHandlers(demoManager, () => {
    demoLifecycle.snapshotExistingBallsForRecording(entities.recordBallKeyframes);
  });

  hud = new HUD();
  if (mode === 'nuggets' || mode === 'ctf' || mode === 'dm') hud.setTeamScore(0, 0);
  healthBarSystem = new HealthBarSystem(camera);
  damageNumberManager = new DamageNumberManager(scene);
  profiler.markTime('hudCreated');

  // Remote player lifecycle: per-frame ticks, pruning, scoreboard
  remotes = createRemotes({
    lazyNetworkManager: () => networkManager,
    lazyScene: () => scene,
    lazyTerrain: () => terrain,
    lazyCamera: () => camera,
    lazyPlayer: () => player,
    lazyHud: () => hud,
    lazyHealthBarSystem: () => healthBarSystem,
    lazyEffects: () => effects,
    logger,
    world,
  });

  // Load player model
  await player.loadModel();
  profiler.markTime('playerModelLoaded');

  // Register all server message handlers (hit/kill/respawn/projectiles/gameState)
  wireNetworkHandlers({
    lazyNetworkManager: () => networkManager,
    lazyScene: () => scene,
    lazyTerrain: () => terrain,
    lazyPlayer: () => player,
    lazyEffects: () => effects,
    lazyHud: () => hud,
    lazyHealthBarSystem: () => healthBarSystem,
    fragMessages,
    explosionTracker,
    logger,
    world,
    setLastSentPos: remotes.setLastSentPos,
    entities: () => entities,
  });

  // Connect to server (non-blocking for offline mode). Classic is a solo
  // ruleset — connecting would hand ball ownership to the server sim,
  // which enrages and spawns the full roster behind your back.
  const serverUrl = (await serverEndpoints).wsUrl;
  await connectServer({ serverUrl, classicMode, networkManager, logger, fragMessages, profiler });
  player.serverOwnsHealth = () => networkManager.isConnected();

  // Initial balls
  for (let i = 0; i < 8; i++) entities.spawnBall();

  // Auto-start demo recording so cool shots are captured seamlessly
  demoManager?.startRecording();
  demoLifecycle.snapshotExistingBallsForRecording(entities.recordBallKeyframes);


  // Frame loop — everything mutable is passed via deps getters
  gameLoop = createGameLoop({
    camera,
    sceneSetup,
    rendererSetup,
    lazyTerrain: () => terrain,
    lazyPlayer: () => player,
    lazyViewModel: () => viewModel,
    vmScene: () => vmSetup.scene,
    vmCamera: () => vmSetup.camera,
    lazyHud: () => hud,
    lazyHealthBarSystem: () => healthBarSystem,
    damageNumberManager: () => damageNumberManager,
    lazyNetworkManager: () => networkManager,
    lazyDemoManager: () => demoManager,
    lazyEffects: () => effects,
    speedLines,
    ambientLayers,
    groundMist: () => groundMist,
    ambientBirds,
    entities,
    combat: () => combat,
    remotes: () => remotes,
    demoLifecycle: () => demoLifecycle,
    waveDirector: () => waveDirector,
    teamBots: () => teamBots,
    world,
    getDummyTick: () => dummyUpdate,
  });
  profiler.markTime('initComplete');

  profiler.printSummary();

  gameLoop.start();
}

// ---- Overlay / pointer-lock / global keys ----
const overlay = document.getElementById('overlay')!;
let gameStarted = false;

const { requestLock } = wireOverlayInput({
  overlay,
  rendererCanvas: renderer.domElement,
  lazyDemoManager: () => demoManager,
  lazyHud: () => hud,
  logger,
  isGameStarted: () => gameStarted,
  lazyPlayer: () => player,
});

// Stale-code badge (noreload dev mode): the vite plugin swallows reloads
// and pushes 'stale:changed' events — we count them so you know how much
// new code is waiting behind Ctrl+R.
const hot = (import.meta as { hot?: { on(e: string, cb: (d: { count: number }) => void): void } }).hot;
if (hot) {
  let stale = 0;
  let badge: HTMLDivElement | null = null;
  hot.on('stale:changed', (d) => {
    stale += d.count;
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText =
        'position:fixed;bottom:8px;right:10px;z-index:9999;pointer-events:none;' +
        'font:11px/1.4 monospace;color:#ffb84d;opacity:0.85;text-shadow:0 1px 2px #000;' +
        'background:rgba(0,0,0,0.35);padding:3px 7px;border-radius:4px;';
      document.body.appendChild(badge);
    }
    badge.textContent = `⟳ ${stale} file${stale === 1 ? '' : 's'} changed — Ctrl+R`;
  });
}

// Auto-start: init immediately, overlay stays hidden until ESC is pressed
init().then(async () => {
  gameStarted = true;

  // Fetch cool shots from server so they're shown in the initial overlay
  demoManager?.fetchCoolShotsFromServer();

  // Desync debugging (snapshot/hash comparison + window debug functions) —
  // dev-only or ?debug, dynamically imported so it stays out of the prod bundle
  if (networkManager && (import.meta.env.DEV || urlParams.debug)) {
    const { wireStateDebug } = await import('./core/stateDebug.js');
    wireStateDebug({
      networkManager,
      getPlayer: () => player,
      remotePlayers: world.remotePlayers,
      projectiles: world.projectiles,
      getLastSentPos: remotes.getLastSentPos,
      logger,
    });
  }
});
