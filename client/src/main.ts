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
import { initVfx } from './effects/vfx.js';
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

import { effectiveResist } from '../../shared/perks.js';
import { REPAIR_HEAL_PER_TICK } from '../../shared/weapons.js';

import { applyDebugHooks } from './game/debugHooks.js';
import { createWorldState } from './game/worldState.js';
import { createCombat } from './game/combat.js';
import { TeamBots } from './game/bots.js';
import { firstTerrain, probeBootMap, bootPrimeTerrain, bootApplySavedMap, type MapSnapshot } from './game/net/world.js';
import type { NetCtx } from './game/net/ctx.js';
import { wirePlayerHooks } from './game/playerHooks.js';
import { createWaveDirector } from './game/waveDirector.js';
import { createDemoLifecycle } from './game/demoLifecycle.js';
import { createEntities } from './game/entities.js';
import { createGameLoop } from './game/gameLoop.js';
import { PlayerSheep } from './game/playerSheep.js';
import { wireNetworkHandlers } from './game/netHandlers.js';
import { createRemotes } from './game/remotes.js';
import { ExplosionTracker } from './utils/ExplosionTracker.js';
import { setupInputTracking } from './utils/InputTracking.js';
import { LoadProfiler } from './utils/profiling.js';

import { createScene } from './world/scene.js';
import { createViewModelScene } from './world/viewmodelScene.js';
import { loadHeightmap, Terrain } from './world/terrain.js';
import { SWARM_SPECS } from './game/species/registry.js';
import { initSwarms } from './entities/swarms.js';
import type { Bolt } from './entities/Turretter.js';

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
let playerSheep: PlayerSheep;

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
  // Probe the saved last-room BEFORE the boot heightmap: when it pings
  // live, its terrain loads as the boot field and the default map is
  // never resident — no default-field flash on F5.
  const onlineBoot = !!urlParams.room || !!urlParams.p2p || (!!urlParams.mode && urlParams.mode !== 'classic');
  const bootSaved = onlineBoot ? await probeBootMap() : null;
  if (!bootSaved || !(await bootPrimeTerrain(bootSaved.httpUrl, bootSaved.map))) {
    await loadHeightmap('/assets/heightmaps/test_vertex.png');
  }
  profiler.markTime('heightmapLoaded');

  terrain = new Terrain(scene, sun.position.clone().normalize());
  profiler.markTime('terrainCreated');

  // Instanced enemy rendering — one draw call per species-part. Species
  // register their part tables here; slots alloc lazily on first spawn.
  initSwarms(scene, terrain, SWARM_SPECS);

  effects = new EffectsManager(scene);
  initVfx(scene); // quarks batch renderer — one draw call per material
  effects.setTerrain(terrain);
  groundMist = new GroundMist(scene, terrain); // valley fog banks
  profiler.markTime('effectsCreated');

  player = new Player(terrain, camera, scene);

  vmSetup = createViewModelScene(camera.aspect);
  viewModel = vmSetup.viewModel;

  entities = makeEntities();

  // Hybrid wave director — scripted beats + a credit pool spent on an
  // unlocking roster. Lives beside entities, drives its spawn fns.
  waveDirector = createWaveDirector({ entities, lazyPlayer: () => player, lazyTerrain: () => terrain, logger });

  combat = makeCombat();
  wirePlayerStatusHooks();
  profiler.markTime('playerCreated');

  // ?mode=nuggets|ctf|dm — offline-vs-bots modes. Bots live in
  // world.remotePlayers so creatures hunt them and projectiles hit them
  // like real players.
  const mode = urlParams.mode ?? undefined;
  // ?mode=classic — the original solo ruleset: bouncy balls only, lost balls
  // teleport back instead of raging (enrage was layered on top later)
  const classicMode = mode === 'classic';
  if (classicMode) setBallEnrage(false);
  // Bot roster waits on the first terrain decision — a room's map spec
  // arrives a few seconds after connect, and bots seeded on the boot
  // heightmap first would spawn → re-seat in the same breath. Offline
  // (no gameState ever) falls back to the boot field after 8s.
  if (mode) {
    world.onTerrainApplied = () => teamBots?.reseatAll();
    void Promise.race([firstTerrain, new Promise((r) => setTimeout(r, 8000))])
      .then(() => { if (!teamBots && !networkManager.isConnected()) setupOfflineMode(mode); });
  }

  // ?yaw/?pitch/?dummy headless-screenshot hooks — see game/debugHooks.ts
  dummyUpdate = applyDebugHooks({ scene, player, terrain, remotePlayers, logger });

  // Initialize networking — NetworkManager owns the WebSocket transport
  networkManager = new NetworkManager();
  profiler.markTime('networkInit');
  wireNetworkLocal();

  await initDemo();

  hud = new HUD();
  // Team-score strip only in team modes — dm painted a permanent
  // ALPHA 0 : 0 BRAVO badge over free-for-all play.
  if (mode === 'nuggets' || mode === 'ctf') hud.setTeamScore(0, 0);
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
    lazyOfflineFfaScores: () => teamBots?.ffaScores ?? null,
    lazyPlayerSheep: () => playerSheep,
  });
  playerSheep = new PlayerSheep(() => networkManager.getLocalPlayerId());

  // Load player model
  await player.loadModel();
  profiler.markTime('playerModelLoaded');




  // Register all server message handlers (hit/kill/respawn/projectiles/gameState)
  const netCtx = wireNetworkHandlers({
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
    retireOfflineBots: () => { teamBots?.dispose(); teamBots = null; },
  });

  await connectPhase(netCtx, bootSaved?.map ?? null, classicMode, mode);


  // Frame loop — everything mutable is passed via deps getters
  gameLoop = makeGameLoop();
  profiler.markTime('initComplete');

  profiler.printSummary();

  gameLoop.start();
}

/** Demo recorder + cool-shots panel + playback lifecycle — everything
 *  capture-related hangs off this one wiring pass. */
async function initDemo(): Promise<void> {
  demoManager = new DemoManager();
  const httpUrl = (await serverEndpoints).httpUrl;
  Logger.initShipping(httpUrl); // WARN+ lines stream to logs/client.log
  demoManager.setServerUrl(httpUrl);
  const { playerData, inputData } = playerProviders(player);
  demoManager.setDataProviders(playerData, inputData);

  const _coolShots = new CoolShotsPanel({
    demoManager,
    overlay,
    requestLock,
  });
  void _coolShots;

  demoLifecycle = makeDemoLifecycle();
  demoLifecycle.wireDemoHandlers(demoManager, () => {
    demoLifecycle.snapshotExistingBallsForRecording(entities.recordBallKeyframes);
  });
}

/** Connect to server (non-blocking for offline mode). Classic is a solo
 *  ruleset — connecting would hand ball ownership to the server sim,
 *  which enrages and spawns the full roster behind your back.
 *  MODE=OFF is solo too: the picker labels it "(solo)", but the empty
 *  mode still joined the default room and the server's move judge kept
 *  correcting the player — the warp complaints. Only a ?room= link or a
 *  ?p2p= code pulls a no-mode session online. */
async function connectPhase(netCtx: NetCtx, savedMap: MapSnapshot | null, classicMode: boolean, mode: string | undefined): Promise<void> {
  const soloMode = !mode && !urlParams.room && !urlParams.p2p;
  // The probed saved map was already primed as boot terrain — apply its
  // structures/arena/interiors/sky now that the net ctx exists.
  if (!classicMode && !soloMode) bootApplySavedMap(netCtx, savedMap);
  const serverUrl = (await serverEndpoints).wsUrl;
  logger.warn(`[diag] serverUrl=${serverUrl} classic=${classicMode || soloMode}`);
  await connectServer({ serverUrl, classicMode: classicMode || soloMode, networkManager, logger, fragMessages, profiler });
  player.serverOwnsHealth = () => networkManager.isConnected();

  // Initial balls — offline only. In a room the wire owns the ball
  // population; boot-time locals were duplicate spam on the default map.
  if (!networkManager.isConnected()) {
    for (let i = 0; i < 8; i++) entities.spawnBall();
  }

  // Auto-start demo recording so cool shots are captured seamlessly
  demoManager?.startRecording();
  demoLifecycle.snapshotExistingBallsForRecording(entities.recordBallKeyframes);
}

// Offline death path — the server's kill+respawn round-trip replicated
// locally. Shared by bot frags and creature/environment damage.
function killLocal(source: string): void {
  if (player.isDead) return;
  player.isDead = true;
  player.health = 0;
  hud.hide();
  hud.setDeathOverlay(true);
  fragMessages.show(`YOU DIED\n${source}`);
  setTimeout(() => {
    player.resetLifeState();
    const a = Math.random() * Math.PI * 2;
    player.pos.set(Math.cos(a) * 40, terrain.getHeight(Math.cos(a) * 40, Math.sin(a) * 40) + 2, Math.sin(a) * 40);
    player.syncMovement();
    player.markTeleport();
    hud.show();
    hud.setDeathOverlay(false);
  }, 3000);
}

// ?mode=nuggets|ctf|dm offline-vs-bots roster — no server, so the TeamBots
// sim drives both teams and world.localTeam marks the player's side
// (normally roomInfo.team, which never arrives offline).
function setupOfflineMode(mode: string): void {
  if (mode !== 'nuggets' && mode !== 'ctf' && mode !== 'dm') return;
  if (mode !== 'dm') world.localTeam = 'alpha';
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
      lazyCamera: () => camera,
      logger,
      world,
      targets: entities.targets,
    },
    {
      dropNuggets: (pos, n, vel) => entities.spawnNuggetsAt(pos, n, vel),
      localPlayerKilled: (killerName) => killLocal(`fragged by ${killerName}`),
      remoteKillFeed: (text) => { fragMessages.show(text); hud.logEvent(text); },
      fragBanner: (text) => { fragMessages.showKill(text); hud.logEvent(text); },
      killFeed: (s, t, ls, lt) => hud.feedKill(s, t, ls, lt),
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
      damageCreature: (id, dmg, att) => {
        const t = entities.targets.find(x => x.id === id);
        if (!t || t.dead) return false;
        return combat.hitTargetLocal(t, dmg, att); // same pipeline as a projectile hit
      },
      botDeploy: (kind, pos, owner) =>
        entities.deployables.plantFor(kind as import('./game/deployables.js').DeployKind, pos, owner),
      botRepairJob: (team, pos, botId) => entities.deployables.repairJob(botId, team, pos),
      // ~50hp/s at think cadence — the same heal a human trigger hold does.
      botWeld: (key) => entities.deployables.weld(key, REPAIR_HEAL_PER_TICK) !== null,
    },
    'alpha',
    mode === 'dm' ? { alpha: 5, bravo: 4 } : { alpha: 4, bravo: 5 },
    mode,
  );
}

function makeEntities(): ReturnType<typeof createEntities> {
  return createEntities({
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
    deployBotFoes: (team) => teamBots?.enemyBotsForTeam(team) ?? [],
    deployDamageBot: (id, dmg, from) => teamBots?.hit(id, dmg, from, 'local') ?? false,
  });
}

function makeCombat(): ReturnType<typeof createCombat> {
  return createCombat({
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
    lazyDeployables: () => entities.deployables,
    lazySpeedLines: () => speedLines,
    fragMessages,
    inputTracking,
    explosionTracker,
    logger,
    world,
    turretBolts: () => entities.turretBolts(),
    consumeBolt: (bolt) => entities.consumeBolt(bolt as Bolt),
    cookBoltsNear: (pos, r) => entities.cookBoltsNear(pos, r),
    reportTargetDamage: (t, dmg) => entities.reportTargetDamage(t, dmg),
    botHit: (id, dmg, fromPos, attackerId) => teamBots?.hit(id, dmg, fromPos, attackerId) ?? false,
    onCreatureKilled: (shooterId) => teamBots?.creatureKilled(shooterId ?? 'local'),
    balls: entities.balls,
    targets: entities.targets,
    nuggets: entities.nuggets,
  });
}

// Player→HUD/viewmodel status hooks + the wildlife truce table.
function wirePlayerStatusHooks(): void {
  // Buzzards join the shootable world — they fly through the shared targets
  // surface so projectiles/blasts hit them. One shot aggros the WHOLE flock
  // into a dive-bomb: 200hp each, a peck that takes half a health bar.
  // Don't shoot the wildlife.
  entities.targets.push(...ambientBirds.targets);
  ambientBirds.onPeck = (pos) => {
    if (player.isDead) return;
    player.lastDamageSource = 'pecked to death by a buzzard';
    player.applyKnockback(pos, 18 * player.mods.knockbackTaken);
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
}

// NetworkManager local wiring: movement sends, offline damage/heal
// authority (same clamps the server applies so offline can't cheat
// easier), and the join loadout announcement.
function wireNetworkLocal(): void {
  player.onNetworkJump = (pos) => networkManager.sendJump(pos);
  player.onNetworkJetpack = (pos) => networkManager.sendJetpack(pos);
  player.onNetworkInput = (input, rotation) => networkManager.sendInputMove(input, rotation);
  player.onSkillUse = () => networkManager.sendSkillUse();
  networkManager.localAuthority = {
    envDamage: (amount) => {
      const dmg = Math.min(40, Math.max(1, Math.round(amount * (1 - effectiveResist(player.mods, player.health, player.maxHealth)))));
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
  networkManager.joinPerk = () => player.perk;
  networkManager.joinClass = () => player.armorClass;
}

function makeDemoLifecycle(): ReturnType<typeof createDemoLifecycle> {
  return createDemoLifecycle({
    lazyScene: () => scene,
    lazyTerrain: () => terrain,
    lazyCamera: () => camera,
    lazyPlayer: () => player,
    lazyDemoManager: () => demoManager,
    lazyViewModel: () => viewModel,
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
}

function makeGameLoop(): ReturnType<typeof createGameLoop> {
  return createGameLoop({
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
    lazyPlayerSheep: () => playerSheep,
  });
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
  lazyNetworkManager: () => networkManager,
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
      world,
      teamBots: () => teamBots,
      getScene: () => scene,
      getCamera: () => player.camera,
      logger,
    });
  }

  // Headless/probe hook — the puppeteer scripts in headless-test drive off
  // this (spawn PlayerModels, read player.pos, aim the camera). DEV or
  // ?debug only; absent in prod builds.
  if (import.meta.env.DEV || urlParams.debug) {
    window.__test = {
      player, scene, entities, world, terrain, viewModel,
      networkManager, demoManager, rendererSetup,
      chatSink: (await import('./game/chat.js')).chatSink,
    };
  }
});
