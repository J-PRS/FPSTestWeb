import * as THREE from 'three';

import {
  CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR,
  FOG_COLOR,
} from './core/config.js';

import Logger, { ChildLogger } from './core/Logger.js';
import { watchDeployVersion } from './core/deployWatch.js';
import { createRenderer } from './core/renderer.js';
import * as sfx from './core/sfx.js';
import { screenShake } from './effects/screenShake.js';

import { DemoManager } from './demo/index.js';
import { InputFlags, JetpackFlags } from './demo/types.js';

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

import { CoolShotsPanel } from './ui/CoolShotsPanel.js';
import { FragMessages } from './ui/FragMessages.js';
import { HealthBarSystem } from './ui/HealthBarSystem.js';
import { HUD } from './ui/hud.js';
import { wireOverlayInput } from './ui/overlayInput.js';

import { applyDebugHooks } from './game/debugHooks.js';
import { createWorldState } from './game/worldState.js';
import { createCombat } from './game/combat.js';
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
    logger,
    world,
    updateBallsPlayback: (dt) => demoLifecycle.updateBallsPlayback(dt),
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

  player.onFire = combat.onFire;
  player.onDisc = combat.onDisc;
  player.onGrenade = combat.onGrenade;
  player.onDiscLauncher = combat.onDiscLauncher;
  player.onChaingun = combat.onChaingun;
  player.onMortar = combat.onMortar;
  player.onGrenadeLauncher = combat.onGrenadeLauncher;
  player.onFlak = combat.onFlak;
  player.onPlasma = combat.onPlasma;
  player.onRailgun = combat.onRailgun;
  player.onLightning = combat.onLightning;
  player.onShotgun = combat.onShotgun;
  player.onCannon = combat.onCannon;
  player.onRocketLauncher = combat.onRocketLauncher;
  player.onWarpThrow = (pos) => { effects.spawnImpact(pos, player.vel); sfx.warpThrow(); };
  player.onWarpTick = (pos) => effects.spawnWarpTrail(pos); // spark trail ON the beacon
  player.onWarp = (from, to) => {
    // Two-stage pop: a collapse burst where you left, a bigger discharge
    // where you arrive — the arrival is the anchor point, it gets more.
    effects.spawnBounce(from, player.vel);
    effects.spawnImpact(from, player.vel);
    effects.spawnBounce(to, player.vel);
    effects.spawnImpact(to, player.vel);
    effects.spawnJetpack(to); // extra sparks at the landing anchor
    screenShake.blast(to, 2.2, player.pos);
    sfx.warpJump(to);
  };
  player.onMelee = combat.onMelee;
  player.onWeaponSwitch = (i) => { viewModel?.switchWeapon(Player.widToWeaponType(i)); sfx.equip(); };
  player.onJump = (pos) => { effects.spawnJumpDust(pos); sfx.jump(); };
  player.onLand = (impactSpeed) => sfx.land(impactSpeed);
  player.onJetpack = (pos) => effects.spawnJetpack(pos);
  player.onSki = (pos, vel) => effects.spawnSkiDust(pos, vel);
  // Footstep dust — small radius (feet), speed drives the puff size so a
  // sprint kicks visibly more than a stroll
  player.onFootDust = (pos, vel) => effects.spawnMoveDust(pos, vel, Math.hypot(vel.x, vel.z), 0.5);
  player.onBounce = (pos, dir) => { effects.spawnBounce(pos, dir); viewModel?.kick(0.5); speedLines.burst(); sfx.bounce(); };
  player.onBlink = (from, to) => {
    // Tracer-style whoosh — cyan streaks stamped along the blink path
    speedLines.surge(from, to, 0x55ccff);
    viewModel?.kick(0.35);
    // Cyan flash at both ends — departure pop + arrival streak along the path
    _blinkDir.subVectors(to, from).normalize();
    effects.spawnBounce(from, _blinkDir);
    effects.spawnBounce(to, _blinkDir);
    sfx.blink();
  };
  player.onDash = (pos, dir) => {
    // White-hot streak line along the dash — reads as a boost, not a redirect
    // (bounce's cyan cone is the redirect cue; dash shares no shape language)
    _blinkDir.copy(dir).multiplyScalar(7).add(pos);
    speedLines.surge(pos, _blinkDir, 0xfff2cc, 10);
    effects.spawnJumpDust(pos);
    viewModel?.kick(0.4);
    sfx.dash();
  };
  player.onSlam = (pos, impactSpeed) => {
    combat.slam(pos, impactSpeed);
    speedLines.burst();
    viewModel?.kick(0.8);
    effects.spawnJumpDust(pos);
    sfx.slam();
  };
  profiler.markTime('playerCreated');

  // ?yaw/?pitch/?dummy headless-screenshot hooks — see game/debugHooks.ts
  dummyUpdate = applyDebugHooks({ scene, player, terrain, remotePlayers, logger });

  // Initialize networking — NetworkManager owns the WebSocket transport
  networkManager = new NetworkManager();
  profiler.markTime('networkInit');
  player.onNetworkJump = (pos) => networkManager.sendJump(pos);
  player.onNetworkJetpack = (pos) => networkManager.sendJetpack(pos);
  player.onNetworkInput = (input, rotation) => networkManager.sendInputMove(input, rotation);

  // Initialize demo system with player/input data providers
  demoManager = new DemoManager();
  const httpUrl = (await serverEndpoints).httpUrl;
  Logger.initShipping(httpUrl); // WARN+ lines stream to logs/client.log
  demoManager.setServerUrl(httpUrl);
  demoManager.setDataProviders(
    {
      get posX() { return player.pos.x; },
      get posY() { return player.pos.y; },
      get posZ() { return player.pos.z; },
      get velX() { return player.vel.x; },
      get velY() { return player.vel.y; },
      get velZ() { return player.vel.z; },
      get yaw() { return player.yaw; },
      get pitch() { return player.pitch; },
    },
    {
      get inputFlags() {
        const input = player.getInputState();
        let flags = 0;
        if (input.forward > 0) flags |= InputFlags.Forward;
        if (input.forward < 0) flags |= InputFlags.Backward;
        if (input.right < 0) flags |= InputFlags.Left;
        if (input.right > 0) flags |= InputFlags.Right;
        if (input.jumpHeld) flags |= InputFlags.Jump;
        if (input.skiHeld) flags |= InputFlags.Ski;
        if (input.firePressed) flags |= InputFlags.Fire;
        if (input.discHeld) flags |= InputFlags.Disc;
        return flags;
      },
      get mouseDeltaX() { return 0; },
      get mouseDeltaY() { return 0; },
      get jetpackFlags() {
        return player.getInputState().jetHeld ? JetpackFlags.Active : JetpackFlags.None;
      },
      get jetpackFuel() { return player.energy; },
    }
  );

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

  // Connect to server (non-blocking for offline mode)
  const serverUrl = (await serverEndpoints).wsUrl;
  profiler.markTime('networkConnectStart');
  networkManager.connect(serverUrl).then(() => {
    profiler.markTime('networkConnected');
    logger.info(`Connected to server at ${serverUrl}`);
  }).catch((error) => {
    logger.error('Failed to connect to server', error);
  });

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
  if (networkManager && (import.meta.env.DEV || new URLSearchParams(location.search).has('debug'))) {
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
