// oxlint-disable-next-line import/no-unassigned-import
// oxlint-disable-next-line import/no-unassigned-import
import './core/polyfills.js'; // toSorted etc. — older engines
import * as THREE from 'three';
import { setInvariantSink } from '../../shared/invariants.js';
import { glitch } from './core/fxDiag.js';

import {
  CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR,
  FOG_COLOR, setBallEnrage,
} from './core/config.js';

import { Logger, ChildLogger } from './core/Logger.js';
import { settings } from './core/settings.js';
import { urlParams, isDevHost } from './core/params.js';
import { feedMode } from './feed/feedMode.js';
import { watchDeployVersion } from './core/deployWatch.js';
import { noteStale, staleCount } from './core/staleFiles.js';
import { createRenderer, GAME_ASPECT } from './core/renderer.js';
import * as sfx from './core/sfx.js';
import { audio } from './core/audio.js';

import { DemoManager } from './demo/index.js';
import { playerProviders } from './demo/playerProviders.js';

import { Player } from './entities/Player.js';
import type { ViewModel } from './entities/ViewModel.js';

import { DamageNumberManager } from './effects/damageNumbers.js';
import { EffectsManager } from './effects/effects.js';
import { initVfx } from './effects/vfx.js';
import { SpeedLines } from './effects/speedLines.js';
import { AmbientParticles } from './effects/ambientParticles.js';
import { GroundMist } from './effects/groundMist.js';
import { AmbientBirds } from './effects/birds.js';

import { resolveServerEndpoints, fleetWorkerUrl } from './networking/endpoints.js';
import { NetworkManager } from './networking/NetworkManager.js';
import { connectServer } from './networking/connectServer.js';

import { CoolShotsPanel } from './ui/CoolShotsPanel.js';
import { FragMessages } from './ui/FragMessages.js';
import { HealthBarSystem } from './ui/HealthBarSystem.js';
import { HUD } from './ui/hud.js';
import { wireOverlayInput } from './ui/overlayInput.js';
import { wireOnboarding } from './ui/onboarding.js';
import { initLogPanel } from './ui/logPanel.js';
import { installOverlapAudit, reportHudOverlap } from './ui/overlapAudit.js';

import { effectiveResist } from '../../shared/perks.js';
import { REPAIR_HEAL_PER_TICK } from '../../shared/weapons.js';

import { applyDebugHooks } from './game/debugHooks.js';
import { createWorldState } from './game/worldState.js';
import { createCombat } from './game/combat.js';
import { TeamBots } from './game/bots/index.js';
import { MODES , type ModeId } from '../../shared/teams.js';
import { firstTerrain, probeBootMap, bootPrimeTerrain, bootApplySavedMap, armSessionVeil, type MapSnapshot } from './game/net/world.js';
import { resolveMapSpec, parseMapSpecJson, type MapSpec } from '../../shared/mapSpec.js';
import { seatKits } from '../../shared/structKits.js';
import { structureColliders } from '../../shared/ballCollide.js';
import { setTeamGridDown } from './game/structureSpecs.js';
import { pingServer } from './game/net/lastRoom.js';
import type { NetCtx } from './game/net/ctx.js';
import { wirePlayerHooks } from './game/playerHooks.js';
import { weaponDef } from './weapons.js';
import { createWaveDirector } from './game/waveDirector.js';
import { createDemoLifecycle } from './game/demoLifecycle.js';
import { createEntities } from './game/entities.js';
import { createGameLoop, noteLocalSnap } from './game/gameLoop.js';
import { PlayerSheep } from './game/playerSheep.js';
import { wireNetworkHandlers } from './game/netHandlers.js';
import { createRemotes } from './game/remotes.js';
import { ExplosionTracker } from './utils/ExplosionTracker.js';
import { setupInputTracking } from './utils/InputTracking.js';
import { LoadProfiler } from './utils/profiling.js';

import { createScene } from './world/scene.js';
import { createViewModelScene } from './world/viewmodelScene.js';
import { Terrain } from './world/terrain.js';
import { loadHeightfieldBin, applyHeightfieldScale } from './world/heightmap.js';
import { SWARM_SPECS } from './game/species/registry.js';
import { initSwarms } from './entities/swarms.js';
import type { Bolt } from './entities/Turretter.js';
import type { DeployKind } from '../../shared/deployables.js';

const logger = new ChildLogger('Main');

// ---- Load Time Profiling ----
const profiler = new LoadProfiler();

// ---- Camera ----
const camera = new THREE.PerspectiveCamera(settings.get('fps-fov') || CAMERA_FOV, GAME_ASPECT, CAMERA_NEAR, CAMERA_FAR);
// Menu FOV field — live via the settings event, no reload needed.
window.addEventListener('fps:set', (e): void => {
  const { key, value } = (e as CustomEvent).detail;
  if (key === 'fps-fov') { camera.fov = value; camera.updateProjectionMatrix(); }
});

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
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let groundMist!: GroundMist; // needs terrain — created in init()
const ambientBirds = new AmbientBirds(scene); // kettle of buzzards on a thermal

// ---- Renderer ----
const rendererSetup = createRenderer(camera, scene);
const { renderer } = rendererSetup;
renderer.setClearColor(FOG_COLOR);

// ---- Game state ----
let demoManager: DemoManager | null = null;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let terrain!: Terrain;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let player!: Player;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let viewModel!: ViewModel;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let vmSetup!: ReturnType<typeof createViewModelScene>;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let hud!: HUD;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let healthBarSystem!: HealthBarSystem;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let damageNumberManager!: DamageNumberManager;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let networkManager!: NetworkManager;
/** Room-join sockets open at boot start (before the handler deps bind)
 *  so the handshake overlaps init — connectPhase awaits this instead of
 *  connecting late. Null for classic/solo/p2p paths. */
let earlyConnP: Promise<void> | null = null;
// All shared mutable entity collections live in world — see game/worldState.ts
const world = createWorldState();
const {remotePlayers} = world;
let dummyUpdate: ((dt: number) => void) | null = null; // ?dummy debug hook
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let effects!: EffectsManager;

// ---- Input tracking ----
const inputTracking = setupInputTracking(logger);

// ---- Explosion tracking ----
const explosionTracker = new ExplosionTracker();

// ---- Score display ----
const fragMessages = new FragMessages();

// ---- Combat pipeline (fire handlers, projectile updates, impact/force) ----
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let combat!: ReturnType<typeof createCombat>;
let teamBots: TeamBots | null = null; // ?mode=nuggets

// ---- Remote player lifecycle (game/remotes.ts); created in init() ----
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let remotes!: ReturnType<typeof createRemotes>;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let playerSheep!: PlayerSheep;

// ---- Demo playback lifecycle (game/demoLifecycle.ts); created in init() ----
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let demoLifecycle!: ReturnType<typeof createDemoLifecycle>;

// ---- Ambient entities: balls/crawlers/turretters/rollers/nuggets ----
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let entities!: ReturnType<typeof createEntities>;
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let waveDirector!: ReturnType<typeof createWaveDirector>;

// ---- Frame loop + render pass (game/gameLoop.ts); created in init() ----
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let gameLoop!: ReturnType<typeof createGameLoop>;

// ---- Boot ----
const serverEndpoints = resolveServerEndpoints();
/** SOLO tab's ?map= pick, resolved client-side before init's heightmap
 *  step — module scope because connectPhase consumes it after init's
 *  locals are gone. */
let soloSpec: { spec: MapSpec; map: MapSnapshot } | null = null;

function makeGameLoop(): ReturnType<typeof createGameLoop> {
  return createGameLoop({
    camera,
    sceneSetup,
    rendererSetup,
    lazyTerrain: (): Terrain => terrain,
    lazyPlayer: (): Player => player,
    lazyViewModel: (): ViewModel => viewModel,
    vmScene: (): THREE.Scene<THREE.Object3DEventMap> => vmSetup.scene,
    vmCamera: (): THREE.PerspectiveCamera => vmSetup.camera,
    lazyHud: (): HUD => hud,
    lazyHealthBarSystem: (): HealthBarSystem => healthBarSystem,
    damageNumberManager: (): DamageNumberManager => damageNumberManager,
    lazyNetworkManager: (): NetworkManager => networkManager,
    lazyDemoManager: (): DemoManager | null => demoManager,
    lazyEffects: (): EffectsManager => effects,
    speedLines,
    ambientLayers,
    groundMist: (): GroundMist => groundMist,
    ambientBirds,
    entities,
    combat: () => combat,
    remotes: () => remotes,
    demoLifecycle: () => demoLifecycle,
    waveDirector: (): { update: (dt: number) => void; readonly elapsed: number; readonly credits: number; } => waveDirector,
    teamBots: (): TeamBots | null => teamBots,
    world,
    getDummyTick: (): ((dt: number) => void) | null => dummyUpdate,
    lazyPlayerSheep: (): PlayerSheep => playerSheep,
  });
}



// NetworkManager local wiring: movement sends, offline damage/heal
// authority (same clamps the server applies so offline can't cheat
// easier), and the join loadout announcement.
function wireNetworkLocal(): void {
  player.onNetworkJump = (pos): void => networkManager.sendJump(pos);
  player.onNetworkJetpack = (pos): void => networkManager.sendJetpack(pos);
  player.onNetworkInput = (input, rotation): void => networkManager.sendInputMove(input, rotation);
  player.onSkillUse = (): void => networkManager.sendSkillUse();
  player.onRespawn = (hold): void => networkManager.sendRespawn(hold === true);
  // G: online it's a wire claim the server resolves; offline the local
  // flag sims run the identical toss themselves (flagrun + CTF both).
  player.onThrowFlag = (): void => {
    if (networkManager.isConnected()) {networkManager.sendThrowFlag(); return;}
    teamBots?.flagrun?.throwLocal();
    teamBots?.ctf?.throwLocal();
    teamBots?.rabbit?.throwLocal('local', player.pos, player.vel, player.yaw, player.pitch);
  };
  // Dead-spectate roster: every remote on the local team. Networked
  // players' teams come from the wire roster; offline GameBots carry
  // `team` on the entity itself. FFA leaves localTeam undefined so the
  // right-click simply does nothing there.
  player.spectateTargets = (): { pos: typeof player.pos; alive: boolean; }[] => {
    if (!world.localTeam) {return [];}
    const out: { pos: typeof player.pos; alive: boolean }[] = [];
    for (const [id, rp] of world.remotePlayers) {
      const team = (rp as { team?: string }).team ?? networkManager.getPlayers().get(id)?.team;
      if (team !== world.localTeam) {continue;}
      out.push({ pos: rp.pos, alive: !rp.isDead });
    }
    return out;
  };
  networkManager.localAuthority = {
    envDamage: (amount): void => {
      const dmg = Math.min(40, Math.max(1, Math.round(amount * (1 - effectiveResist(player.mods, player.health, player.maxHealth)))));
      if (player.isDead) {return;}
      player.health = Math.max(0, player.health - dmg);
      player.lastDamageSource = 'the wilderness';
      hud.showDamage(player.pos, dmg);
      sfx.playerHurt();
      if (player.health <= 0) { teamBots?.localDied(); killLocal('killed by the wilderness'); }
    },
    // Dead press = revive once the deadline lapsed (the only dead state
    // past 3s is a held corpse); inside the countdown it just releases
    // a die+spectate hold and the timer revives on schedule — the server
    // refuses to skip the pending timer, so offline must not either.
    respawn: (): void => {
      if (!player.isDead) {killLocal('respawned'); return;}
      if (respawnLapsed) {reviveLocal();}
      else {player.respawnHeld = false;}
    },
    heal: (amount): void => {
      player.health = Math.min(100, player.health + Math.min(25, Math.max(1, Math.round(amount))));
    },
  };
  networkManager.joinPerk = () => player.perk;
  networkManager.joinClass = (): "light" | "medium" | "heavy" => player.armorClass;
}



// Player→HUD/viewmodel status hooks + the wildlife truce table.
function wirePlayerStatusHooks(): void {
  // Buzzards join the shootable world — they fly through the shared targets
  // surface so projectiles/blasts hit them. One shot aggros the WHOLE flock
  // into a dive-bomb: 200hp each, a peck that takes half a health bar.
  // Don't shoot the wildlife.
  entities.targets.push(...ambientBirds.targets);
  ambientBirds.onPeck = (pos): void => {
    if (player.isDead) {return;}
    player.lastDamageSource = 'pecked to death by a buzzard';
    player.applyKnockback(pos, 18 * player.mods.knockbackTaken);
    networkManager?.sendEnvironmentDamage(45);
    hud?.showDamage(pos, 45);
    sfx.playerHurt();
  };

  wirePlayerHooks({ player, combat, effects, viewModel, speedLines, world, scene, terrain });
  // Arm the viewmodel to the persisted kit's active slot — resetLifeState
  // re-arms on every respawn, but the FIRST life would otherwise open on
  // the default bolt model while the HUD reads the recalled loadout.
  viewModel?.switchWeapon(weaponDef(player.loadout[player.weaponIndex]).weaponType);
  player.model?.setWeapon(weaponDef(player.loadout[player.weaponIndex]).weaponType);
  // Spectator fly: strip the combat HUD, leave only a "SPECTATING" hint
  player.onSpectate = (on): void => {
    if (on) { hud.hide(); hud.setSpectatorHint(true); }
    // Died mid-flight: the death path owns the HUD — don't resurface it
    else { hud.setSpectatorHint(false); if (!player.isDead) {hud.show();} }
  };
  player.onCloak = (on): void => { hud.setCloak(on); viewModel.setGhost(on); };
  // Shield: HUD chip + cyan vignette, viewmodel charge glow, synth cues.
  player.onShield = (on): void => {
    hud.setShield(on);
    viewModel.setShield(on);
    if (on) {sfx.shieldOn();} else {sfx.shieldBreak();}
  };
  player.onMend = (on): void => {
    hud.setMend(on);
    viewModel.setMend(on);
    if (on) {sfx.mendOn();} else {sfx.mendOff();}
  };
  player.onDeploy = (): void => entities.deployables.deploy();
}



function makeCombat(): ReturnType<typeof createCombat> {
  return createCombat({
    lazyScene: (): THREE.Scene<THREE.Object3DEventMap> => scene,
    lazyTerrain: (): Terrain => terrain,
    lazyCamera: (): THREE.PerspectiveCamera => camera,
    lazyPlayer: (): Player => player,
    lazyViewModel: (): ViewModel => viewModel,
    lazyDemoManager: (): DemoManager | null => demoManager,
    lazyNetworkManager: (): NetworkManager => networkManager,
    lazyEffects: (): EffectsManager => effects,
    lazyHud: (): HUD => hud,
    lazyHealthBarSystem: (): HealthBarSystem => healthBarSystem,
    lazyDamageNumbers: (): DamageNumberManager => damageNumberManager,
    lazyDeployables: () => entities.deployables,
    lazySpeedLines: (): SpeedLines => speedLines,
    fragMessages,
    inputTracking,
    explosionTracker,
    logger,
    world,
    turretBolts: (): Bolt[] => entities.turretBolts(),
    consumeBolt: (bolt): void => entities.consumeBolt(bolt as Bolt),
    cookBoltsNear: (pos, r): THREE.Vector3[] => entities.cookBoltsNear(pos, r),
    reportTargetDamage: (t, dmg): void => entities.reportTargetDamage(t, dmg),
    botHit: (id, dmg, fromPos, attackerId, weaponType, air): boolean => teamBots?.hit(id, dmg, fromPos, attackerId, { weapon: weaponType, air }) ?? false,
    onCreatureKilled: (shooterId): void | undefined => teamBots?.creatureKilled(shooterId ?? 'local'),
    balls: entities.balls,
    targets: entities.targets,
    nuggets: entities.nuggets,
  });
}



function makeEntities(): ReturnType<typeof createEntities> {
  return createEntities({
    scene,
    lazyTerrain: (): Terrain => terrain,
    camera,
    lazyPlayer: (): Player => player,
    lazyEffects: (): EffectsManager => effects,
    lazyHud: (): HUD => hud,
    lazyNetworkManager: (): NetworkManager => networkManager,
    lazyDemoManager: (): DemoManager | null => demoManager,
    lazyViewModel: (): ViewModel => viewModel,
    logger,
    world,
    updateBallsPlayback: (dt): void => demoLifecycle.updateBallsPlayback(dt),
    // Team mode sweeps gems toward whoever's nearest — set once bots spawn.
    nuggetCollectors: (): { id: string; pos: THREE.Vector3; alive: boolean; pickupScale: number; }[] => teamBots?.collectors() ?? [],
    onNuggetCollect: (id): void | undefined => teamBots?.collect(id),
    lazyCombat: () => combat,
    deployEnemyBots: (): { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; }[] => teamBots?.enemyBotsForLocal() ?? [],
    deployBotFoes: (team): { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; }[] => teamBots?.enemyBotsForTeam(team) ?? [],
    deployDamageBot: (id, dmg, from): boolean => teamBots?.hit(id, dmg, from, 'local') ?? false,
    // Offline base grid — a shelled generator drops its team's gate
    // panes (colliders + visuals), revive puts them back.
    deployBasePower: (team, on): void => setTeamGridDown(team, !on),
    deployDamageNumbers: (): DamageNumberManager => damageNumberManager,
    deployItemBar: (item, ally): void => healthBarSystem.showDamage(item, ally),
  });
}



// ?mode=<mode> offline-vs-bots roster — no server, so the TeamBots
// sim drives both teams and world.localTeam marks the player's side
// (normally roomInfo.team, which never arrives offline).
function setupOfflineMode(mode: string, mapSpec?: MapSpec): void {
  const spec = MODES[mode as keyof typeof MODES];
  if (!spec) {return;}
  if (!spec.ffa) {world.localTeam = 'alpha';}
  // Bot roster: explicit ?bots wins, then the map's own count, then the
  // mode's classic spread. Non-flagrun modes split N across both sides
  // (the player occupies one alpha slot already).
  const want = urlParams.soloBots ?? mapSpec?.bots ?? mapSpec?.botFill;
  let counts;
  if (mode === 'flagrun') {counts = { alpha: want ?? 0, bravo: 0 };}
  else if (want === undefined) {counts = spec.ffa ? { alpha: 5, bravo: 4 } : { alpha: 4, bravo: 5 };}
  else {counts = { alpha: Math.floor(want / 2), bravo: Math.ceil(want / 2) };}
  teamBots = new TeamBots(
    {
      lazyPlayer: (): Player => player,
      lazyTerrain: (): Terrain => terrain,
      lazyEffects: (): EffectsManager => effects,
      lazyHud: (): HUD => hud,
      lazyHealthBarSystem: (): HealthBarSystem => healthBarSystem,
      lazyNetworkManager: (): NetworkManager => networkManager,
      lazyDemoManager: (): DemoManager | null => demoManager,
      lazyScene: (): THREE.Scene<THREE.Object3DEventMap> => scene,
      lazyCamera: (): THREE.PerspectiveCamera => camera,
      logger,
      world,
      targets: entities.targets,
    },
    {
      dropNuggets: (pos, n, vel): void => entities.spawnNuggetsAt(pos, n, vel),
      localPlayerKilled: (killerName): void => killLocal(`fragged by ${killerName}`),
      remoteKillFeed: (text): void => { fragMessages.show(text); hud.logEvent(text); },
      fragBanner: (text): void => { fragMessages.showKill(text); hud.logEvent(text); },
      killFeed: (s, t, ls, lt, meta): void => hud.feedKill(s, t, ls, lt, meta),
      nearestNugget: (pos, maxDist) => {
        let best: typeof entities.nuggets[0] | null = null;
        let bd = maxDist * maxDist;
        for (const n of entities.nuggets) {
          if (n.collected || n.dead) {continue;}
          const d = n.pos.distanceToSquared(pos);
          if (d < bd) { bd = d; best = n; }
        }
        return best;
      },
      nearestCreature: (pos, maxDist) => {
        let best = null;
        let bd = maxDist * maxDist;
        for (const t of entities.targets) {
          if (t.dead || t.scoreless) {continue;}
          const d = t.pos.distanceToSquared(pos);
          if (d < bd) { bd = d; best = t; }
        }
        return best;
      },
      hasCreatures: (): boolean => entities.targets.some((t): boolean => !t.scoreless),
      damageCreature: (id, dmg, att): boolean => {
        const t = entities.targets.find((x): boolean => x.id === id);
        if (!t || t.dead) {return false;}
        return combat.hitTargetLocal(t, dmg, att); // same pipeline as a projectile hit
      },
      botDeploy: (kind, pos, owner): void =>
        entities.deployables.plantFor(kind as DeployKind, pos, owner),
      botRepairJob: (team, pos, botId): { key: string; pos: THREE.Vector3; frac: number; } | null => entities.deployables.repairJob(botId, team, pos),
      // ~50hp/s at think cadence — the same heal a human trigger hold does.
      botWeld: (key): boolean => entities.deployables.weld(key, REPAIR_HEAL_PER_TICK) !== null,
    },
    'alpha',
    counts,
    mode as ModeId,
    mapSpec,
  );
  // Flag Run starts you beside the nearest enemy flag — the ring is
  // built around your spawn pos, so the first grab is one hop away.
  const spot = teamBots.flagrun?.spawnPoint();
  if (spot) {
    player.pos.set(spot.x + 3, terrain.getHeight(spot.x + 3, spot.z + 3) + 2, spot.z + 3);
    noteLocalSnap();
    player.syncMovement();
    player.markTeleport();
  }
}



/** Connect to server (non-blocking for offline mode). Classic is a solo
 *  ruleset — connecting would hand ball ownership to the server sim,
 *  which enrages and spawns the full roster behind your back.
 *  MODE=OFF is solo too: the picker labels it "(solo)", but the empty
 *  mode still joined the default room and the server's move judge kept
 *  correcting the player — the warp complaints. Only a ?room= link or a
 *  ?p2p= code pulls a no-mode session online. flagrun is the same kind
 *  of solo ruleset (local circuit + optional offline bot cappers): an
 *  explicit ?room/?p2p still wins, otherwise it must not connect —
 *  connecting joined the server's default room and the player spawned
 *  into a live nuggets match instead of the lap. */
async function connectPhase(netCtx: NetCtx, savedMap: MapSnapshot | null, classicMode: boolean, mode: string | undefined): Promise<void> {
  // No ?room and no ?p2p = solo, full stop. A mode pick alone must NOT
  // connect — the SOLO tab's whole job is an offline match, and the old
  // mode-means-online rule silently dropped solo players into the
  // server's default room.
  const soloMode = !urlParams.room && !urlParams.p2p;
  // The probed saved map was already primed as boot terrain — apply its
  // structures/arena/interiors/sky now that the net ctx exists. Solo's
  // own spec takes the same path so a SOLO-picked map is identical —
  // including seatKits, which the server normally runs before broadcast:
  // without it every piece stands at authored y and dirt pokes through
  // decks (bastion terrain varies ~15m under a genhouse footprint).
  if (!classicMode && soloMode && soloSpec) {
    seatKits(soloSpec.spec.structures, (x, z): number => terrain.getHeight(x, z));
  }
  if (!classicMode) {bootApplySavedMap(netCtx, soloMode ? (soloSpec?.map ?? null) : savedMap);}
  profiler.markTime('savedMapApplied');
  const serverUrl = (await serverEndpoints).wsUrl;
  logger.info(`[diag] serverUrl=${serverUrl} classic=${classicMode || soloMode}`);
  // F5 with a stored session token = the server may hand back our old
  // body — but only a LIVE host earns the restore veil. Dead server
  // means the offline world owns the first frames outright; a "restoring"
  // curtain over a connect that can never land is the wrong order.
  // Room-join sockets already flew at boot start (earlyConnP) — the
  // veil probe kicked alongside them and arms whenever it lands.
  if (earlyConnP) {
    await earlyConnP;
  } else {
    if (!classicMode && !soloMode && settings.get('fps-session-token')) {
      if (await pingServer((await serverEndpoints).httpUrl)) {armSessionVeil();}
      profiler.markTime('veilProbed');
    }
    const ep = await serverEndpoints;
    await connectServer({
      serverUrl, classicMode: classicMode || soloMode, networkManager, logger, fragMessages, profiler,
      bootMap: soloSpec?.spec ?? soloSpec?.map ?? savedMap,
      // Fleet reconnects re-ask the matchmaker for a live worker — retrying
      // the dead worker's direct URL forever would never land anywhere.
      resolveUrl: ep.fleet && ep.lobbyUrl ? (): Promise<string | null> => fleetWorkerUrl(ep.lobbyUrl!) : undefined,
    });
  }
  player.serverOwnsHealth = (): boolean => networkManager.isConnected();

  // Offline start waits on stable frames — the player spawn anchor,
  // deploys, balls and demo recording all land after warmup instead of
  // mid-compile-hitch (the online path gates on the session veil).
  if (!networkManager.isConnected()) {await gameLoop.whenStable();}
  if (classicMode || soloMode) {player.unfreezeInput(); viewModel.draw();}
  // Spec maps spawn you at an authored anchor (team spawn > generic
  // spawn > own base) — origin on a T2 port can be kilometers from play.
  if (soloMode && soloSpec) {
    const s = soloSpec.spec;
    const anchor = s.teamSpawns?.alpha?.[0] ?? s.spawns?.[0] ?? s.bases?.alpha;
    if (anchor) {
      player.pos.set(anchor.x, terrain.getHeight(anchor.x, anchor.z) + 2, anchor.z);
      noteLocalSnap();
      player.syncMovement();
      player.markTeleport();
    }
    if (s.name) {world.mapName = s.name;}
    else {world.mapName = urlParams.soloMap ?? undefined;}
    world.mode = mode ?? s.mode;
    // Deploys — generators/sentries are server-seeded in rooms; offline
    // they spawn as remote items (same visuals + repair/weld paths).
    // pos.y rides the lowest structure top above authored Y within 12m —
    // Room.deployFloor's rule, so the generator lands on the vault deck.
    const cols = structureColliders(s.structures);
    let depId = 9000;
    for (const d of s.deploys ?? []) {
      let floor = Infinity;
      for (const c of cols) {
        const lx = (d.pos.x - c.cx) * c.cos + (d.pos.z - c.cz) * c.sin;
        const lz = -(d.pos.x - c.cx) * c.sin + (d.pos.z - c.cz) * c.cos;
        if (Math.abs(lx) > c.hx || Math.abs(lz) > c.hz) {continue;}
        const t = c.cy + c.hy;
        if (t > d.pos.y && t < floor && t <= d.pos.y + 12) {floor = t;}
      }
      const y = floor === Infinity ? Math.max(d.pos.y, terrain.getHeight(d.pos.x, d.pos.z)) : floor;
      entities.deployables.remoteSpawn(((depId += 1) - 1), {
        owner: d.team ? `base:${d.team}` : 'base',
        kind: d.kind as DeployKind,
        pos: Object.assign({}, d.pos, {y}),
        team: d.team,
      });
    }
  }

  // Initial balls — offline only. In a room the wire owns the ball
  // population; boot-time locals were duplicate spam on the default map.
  if (!networkManager.isConnected()) {
    for (let i = 0; i < 4; i += 1) {entities.spawnBall();} // OG startingSpawnCount
  }

  // Auto-start demo recording so cool shots are captured seamlessly —
  // the clip feed never records (it only replays).
  if (!feedMode.on) {demoManager?.startRecording();}
  demoLifecycle.snapshotExistingBallsForRecording(entities.recordBallKeyframes);
}



/** Demo recorder + cool-shots panel + playback lifecycle — everything
 *  capture-related hangs off this one wiring pass. */
async function initDemo(): Promise<void> {
  demoManager = new DemoManager();
  const {httpUrl} = (await serverEndpoints);
  Logger.initShipping(httpUrl); // WARN+ lines stream to logs/client.log
  demoManager.setServerUrl(httpUrl);
  // The recorder needs the REAL render canvas — the DOM carries ~13
  // canvases (atlases, shadow buffers); "largest" picks a black texture.
  demoManager.video.setCanvas(renderer.domElement);
  // Audio rides the post-compressor mix — null until the first gesture
  // unlocks the AudioContext, so early clips just stay video-only.
  demoManager.video.setAudioSource((): { ctx: AudioContext; node: AudioNode; } | null =>
    audio.context instanceof AudioContext && audio.mixNode
      ? { ctx: audio.context as AudioContext, node: audio.mixNode }
      : null);
  // Silently re-arm the previously-picked clips folder (no prompt — the
  // handle reuses its stored permission until Chrome asks for a re-grant,
  // which happens inside the next F9 gesture via pickClipsDir).
  import('./demo/clipSink.js').then((m): Promise<boolean> => m.restoreClipsDir()).catch((): void => undefined);
  const { playerData, inputData } = playerProviders(player);
  demoManager.setDataProviders(playerData, inputData);

  const _coolShots = new CoolShotsPanel({
    demoManager,
    overlay,
    requestLock,
  });

  demoLifecycle = makeDemoLifecycle();
  demoLifecycle.wireDemoHandlers(demoManager, (): void => {
    demoLifecycle.snapshotExistingBallsForRecording(entities.recordBallKeyframes);
  });
}



/** SOLO map pick: fetch maps/<name>.json off the static route and resolve
 *  it locally — the same spec the server would load for a hosted room.
 *  Returns null on any miss; the boot falls back to the default field. */
async function loadSoloSpec(name: string): Promise<{ spec: MapSpec; map: MapSnapshot } | null> {
  if (!/^[\w-]{1,32}$/.test(name)) {return null;}
  try {
    const { httpUrl } = await serverEndpoints;
    const res = await fetch(`${httpUrl}/maps/${name}.json`, { cache: 'no-cache' });
    if (!res.ok) {return null;}
    const spec = resolveMapSpec(parseMapSpecJson(await res.text()));
    // The wire sends the resolved spec's world fields verbatim — a solo
    // boot applies the same subset (spawns/bases feed TeamBots instead).
    return { spec, map: spec };
  } catch { return null; }
}



async function init(): Promise<void> {
  profiler.markTime('initStart');
  // Invariant violations land in the glitch census — a named truth
  // breaking shows in the alt+q dump, never crashes the match.
  setInvariantSink(glitch);
  watchDeployVersion();
  networkManager = new NetworkManager();
  networkManager.armWireQueue();
  // Boot resume: a bare '/' load with a remembered room rejoins it — the
  // canonical /s/<room> path is written BEFORE anything reads urlParams,
  // so every downstream consumer (early wire, join payload, lobby) sees
  // the resumed identity. Explicit leaves clear fps-last-room, so its
  // presence means "was in a match and never left". A solo pick
  // (fps-solo) suppresses the resume — the player chose offline.
  if (!urlParams.room && !urlParams.p2p && !urlParams.solo && settings.get('fps-last-room')) {
    const resume = settings.get('fps-last-room');
    history.replaceState(null, '', `/s/${encodeURIComponent(resume)}${window.location.search}`);
  }
  const onlineBoot = Boolean(urlParams.room) || Boolean(urlParams.p2p);
  if (urlParams.room) {
    settings.set('fps-last-room', urlParams.room);
    settings.set('fps-solo', 0);
  }
  // The veil probe and the socket flight are pure network — kick both
  // now so they overlap ALL of init instead of stacking after it.
  // wireIn queues inbound until wireNetworkHandlers binds the deps
  // (markWireReady right after it returns). p2p/classic keep the late
  // connectServer path — they need machinery that isn't built yet.
  const earlyWire = Boolean(urlParams.room) && !urlParams.p2p && urlParams.mode !== 'classic';
  if (onlineBoot && urlParams.mode !== 'classic' && settings.get('fps-session-token')) {
    serverEndpoints
      .then((ep): Promise<boolean> => pingServer(ep.httpUrl))
      .then((live): void => { if (live) {armSessionVeil(); profiler.markTime('veilProbed');} return; })
      .catch((): void => { /* dead-host probe — the offline world owns first frames */ });
  }
  earlyConnP = earlyWire
    ? serverEndpoints.then(async (ep): Promise<void> => {
        profiler.markTime('networkConnectStart');
        try {
          await networkManager.connect(ep.wsUrl, undefined, ep.fleet && ep.lobbyUrl ? (): Promise<string | null> => fleetWorkerUrl(ep.lobbyUrl!) : undefined);
          profiler.markTime('networkConnected');
          logger.info(`Connected to server at ${ep.wsUrl}`);
        } catch (error) { logger.error('Failed to connect to server', error); }
      return; })
    : null;
  // Probe the saved last-room BEFORE the boot heightmap: when it pings
  // live, its terrain loads as the boot field and the default map is
  // never resident — no default-field flash on F5.
  // Solo-with-a-map: ?map= without a room is the SOLO tab's pick — fetch
  // the spec JSON off the same static /maps route the wire path uses and
  // resolve it client-side (resolveMapSpec is shared/, pure).
  soloSpec = !onlineBoot && urlParams.soloMap
    ? await loadSoloSpec(urlParams.soloMap) : null;
  const bootSaved = onlineBoot ? await probeBootMap() : null;
  const soloPrimed = soloSpec?.map && (await serverEndpoints).httpUrl
    ? await bootPrimeTerrain((await serverEndpoints).httpUrl, soloSpec.map).catch((): boolean => false)
    : false;
  if (!soloPrimed && (!bootSaved || !(await bootPrimeTerrain(bootSaved.httpUrl, bootSaved.map)))) {
    await loadHeightfieldBin('/assets/heightmaps/heightmap.bin');
  }
  profiler.markTime('heightmapLoaded');

  terrain = new Terrain(scene, sun.position.clone().normalize());
  // A primed field (solo ?map= / saved-room probe) already carries its
  // gain in hmScale — the fresh Terrain built its uniforms at 1x.
  applyHeightfieldScale(terrain);
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
  profiler.markTime('playerCtor');
  // Solo spec anchor up front — the camera renders warmup frames from the
  // real spawn point instead of the origin, so connectPhase's post-stable
  // placement is a same-spot reassert, not a visible jump.
  if (!onlineBoot && soloSpec) {
    const a0 = soloSpec.spec.teamSpawns?.alpha?.[0] ?? soloSpec.spec.spawns?.[0] ?? soloSpec.spec.bases?.alpha;
    if (a0) {
      player.pos.set(a0.x, terrain.getHeight(a0.x, a0.z) + 2, a0.z);
      noteLocalSnap();
      player.syncMovement();
      player.markTeleport();
    }
  }
  // The GLB is a ~0.4-0.6s fetch+parse the first-person camera never
  // draws — kicking it at construction overlaps it with the rest of
  // init and the connect handshake instead of serializing it before
  // connectPhase. setVisible(false) still applies in the same
  // microtask the load resolves, so it can never flash rendered.
  player.loadModel()
    .then((): void => profiler.markTime('playerModelLoaded'))
    .catch((error): void => logger.warn('PlayerModel load gave up', { error: String(error) }));

  vmSetup = createViewModelScene(camera.aspect);
  ({viewModel} = vmSetup);
  profiler.markTime('viewmodel');

  entities = makeEntities();
  profiler.markTime('entities');

  // Hybrid wave director — scripted beats + a credit pool spent on an
  // unlocking roster. Lives beside entities, drives its spawn fns.
  waveDirector = createWaveDirector({ entities, lazyPlayer: (): Player => player, lazyTerrain: (): Terrain => terrain, logger });

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
  if (classicMode) {setBallEnrage(false);}
  // Bot roster waits on the first terrain decision — a room's map spec
  // arrives a few seconds after connect, and bots seeded on the boot
  // heightmap first would spawn → re-seat in the same breath. Offline
  // (no gameState ever) falls back to the boot field after 8s.
  if (mode || soloSpec) {
    world.onTerrainApplied = (): void | undefined => teamBots?.reseatAll();
    Promise.race([firstTerrain, new Promise((r): NodeJS.Timeout => setTimeout(r, 8000))])
      // Hold the roster kick-off until frames stabilize — spawning a full
      // bot match mid-compile-hitch seeds bad sim from frame one.
      .then(async (): Promise<void> => { await gameLoop?.whenStable(); if (!teamBots && !networkManager.isConnected() && mode) {setupOfflineMode(mode, soloSpec?.spec);} return; }).catch((): void => undefined);
  }

  // ?yaw/?pitch/?dummy headless-screenshot hooks — see game/debugHooks.ts.
  // Dev hosts only: on a public deploy these are a scriptable aim/spawn
  // surface for anyone who reads the bundle.
  if (isDevHost()) {
    dummyUpdate = applyDebugHooks({ scene, player, terrain, remotePlayers, logger });
  }

  // Initialize networking — NetworkManager owns the WebSocket transport
  profiler.markTime('networkInit');
  wireNetworkLocal();

  await initDemo();

  hud = new HUD();
  // Team-score strip only in team modes — dm painted a permanent
  // ALPHA 0 : 0 BRAVO badge over free-for-all play.
  if (mode === 'nuggets' || mode === 'ctf' || mode === 'flagrun') {hud.setTeamScore(0, 0);}
  healthBarSystem = new HealthBarSystem(camera);
  damageNumberManager = new DamageNumberManager(scene);
  profiler.markTime('hudCreated');

  // Remote player lifecycle: per-frame ticks, pruning, scoreboard
  remotes = createRemotes({
    lazyNetworkManager: (): NetworkManager => networkManager,
    lazyScene: (): THREE.Scene<THREE.Object3DEventMap> => scene,
    lazyTerrain: (): Terrain => terrain,
    lazyCamera: (): THREE.PerspectiveCamera => camera,
    lazyPlayer: (): Player => player,
    lazyHud: (): HUD => hud,
    lazyHealthBarSystem: (): HealthBarSystem => healthBarSystem,
    lazyEffects: (): EffectsManager => effects,
    logger,
    world,
    lazyOfflineFfaScores: (): Map<string, number> | null => teamBots?.ffaScores ?? null,
    lazyPlayerSheep: (): PlayerSheep => playerSheep,
  });
  playerSheep = new PlayerSheep((): string => networkManager.getLocalPlayerId());

  // The model load was kicked at playerCtor — it resolves in the
  // background through the connect handshake.




  // Register all server message handlers (hit/kill/respawn/projectiles/gameState)
  const netCtx = wireNetworkHandlers({
    lazyNetworkManager: (): NetworkManager => networkManager,
    lazyScene: (): THREE.Scene<THREE.Object3DEventMap> => scene,
    lazyTerrain: (): Terrain => terrain,
    lazyPlayer: (): Player => player,
    lazyEffects: (): EffectsManager => effects,
    lazyHud: (): HUD => hud,
    lazyHealthBarSystem: (): HealthBarSystem => healthBarSystem,
    lazyDemoManager: (): DemoManager | null => demoManager,
    fragMessages,
    explosionTracker,
    logger,
    world,
    setLastSentPos: remotes.setLastSentPos,
    entities: () => entities,
    retireOfflineBots: (): void => { teamBots?.dispose(); teamBots = null; },
    hearLocalChat: (t, tm, v): void | undefined => teamBots?.hearLocal(t, tm, v),
  });
  // Deps bound — inbound that queued during the early socket flight
  // flushes through the normal dispatch now, in wire order.
  networkManager.markWireReady();

  // Frame loop — everything mutable is passed via deps getters. The
  // loop starts BEFORE the handshake completes: first frames + shader
  // compile overlap the connect/worldstate flight instead of stacking
  // after it (the terrain-swap machinery already runs mid-game).
  gameLoop = makeGameLoop();
  profiler.markTime('initComplete');
  // Offline boots hold the player out of play during warmup — input
  // frozen from first frame until whenStable() releases him in
  // connectPhase (online paths gate on the session veil instead).
  if (classicMode || (!urlParams.room && !urlParams.p2p)) {player.freezeInput();}
  gameLoop.start();

  const connP = connectPhase(netCtx, bootSaved?.map ?? null, classicMode, mode);

  profiler.printSummary();

  await connP;
}

function makeDemoLifecycle(): ReturnType<typeof createDemoLifecycle> {
  return createDemoLifecycle({
    lazyScene: (): THREE.Scene<THREE.Object3DEventMap> => scene,
    lazyTerrain: (): Terrain => terrain,
    lazyCamera: (): THREE.PerspectiveCamera => camera,
    lazyPlayer: (): Player => player,
    lazyDemoManager: (): DemoManager | null => demoManager,
    lazyViewModel: (): ViewModel => viewModel,
    damageNumberManager: (): DamageNumberManager => damageNumberManager,
    fragMessages: (): FragMessages => fragMessages,
    lazyHud: (): HUD => hud,
    balls: entities.balls,
    targets: entities.targets,
    crawlers: entities.crawlers,
    scarabs: entities.scarabs,
    gnats: entities.gnats,
    snakes: entities.snakes,
    banelings: entities.banelings,
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



// Offline death path — the server's kill+respawn round-trip replicated
// locally. Shared by bot frags and creature/environment damage.
// True once the 3s respawn deadline has fired — same "pending timer is
// NOT skippable" gate the server applies in respawnNow.
let respawnLapsed = false;

/** Offline revive — the mirror of the server's respawnPlayer path. */
function reviveLocal(): void {
  player.resetLifeState();
  const spot = teamBots?.flagrun?.spawnPoint();
  // Spec maps respawn at authored anchors (team spawn > generic spawn >
  // own base) — same priority as the solo boot spawn.
  const specAnchor = soloSpec?.spec.teamSpawns?.alpha?.[0] ?? soloSpec?.spec.spawns?.[0] ?? soloSpec?.spec.bases?.alpha;
  if (spot) {
    player.pos.set(spot.x + 3, terrain.getHeight(spot.x + 3, spot.z + 3) + 2, spot.z + 3);
  } else if (specAnchor) {
    player.pos.set(specAnchor.x, terrain.getHeight(specAnchor.x, specAnchor.z) + 2, specAnchor.z);
  } else {
    const a = Math.random() * Math.PI * 2;
    player.pos.set(Math.cos(a) * 40, terrain.getHeight(Math.cos(a) * 40, Math.sin(a) * 40) + 2, Math.sin(a) * 40);
  }
  noteLocalSnap();
  player.syncMovement();
  player.markTeleport();
  viewModel.draw();
  hud.show();
  hud.setDeathOverlay(false);
}



function killLocal(source: string): void {
  if (player.isDead) {return;}
  // Any death is a flag event — carried flags drop; in rabbit the
  // first corpse is what spawns the flag at all. Idempotent for the
  // bot-frag path, which already ran localDied() before the banner.
  teamBots?.localDied();
  world.deathCounts.set('local', (world.deathCounts.get('local') ?? 0) + 1);
  player.isDead = true;
  player.health = 0;
  respawnLapsed = false;
  hud.hide();
  hud.setDeathOverlay(true);
  fragMessages.show(`YOU DIED\n${source}`);
  setTimeout((): void => {
    respawnLapsed = true;
    // L's die+spectate parks the corpse offline too — the deadline lapses
    // and the player stays dead until a dead-state respawn press revives.
    if (!player.respawnHeld) {reviveLocal();}
  }, 3000);
}

// ---- Overlay / pointer-lock / global keys ----
const overlay = document.getElementById('overlay')!;
let gameStarted = false;

const { requestLock } = wireOverlayInput({
  overlay,
  rendererCanvas: renderer.domElement,
  lazyDemoManager: (): DemoManager | null => demoManager,
  lazyHud: (): HUD => hud,
  logger,
  isGameStarted: (): boolean => gameStarted,
  lazyPlayer: (): Player => player,
  lazyNetworkManager: (): NetworkManager => networkManager,
});

// Stale-code badge (noreload dev mode): the vite plugin swallows reloads
// and pushes 'stale:changed' events — we count them so you know how much
// new code is waiting behind Ctrl+R.
// The literal `import.meta.hot` token is required — vite's HMR inject
// (createHotContext) only fires when the source spells it out; a
// destructured `const {hot} = import.meta` leaves it undefined and the
// listener silently never registers.
const hot = import.meta.hot as { on(e: string, cb: (d: { count: number; files?: string[] }) => void): void } | undefined;
if (hot) {
  let badge: HTMLDivElement | null = null;
  hot.on('stale:changed', (d): void => {
    noteStale(d.files, d.count);
    const stale = staleCount();
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'stale-badge';
      badge.style.cssText =
        'position:fixed;bottom:8px;right:10px;z-index:9999;pointer-events:none;' +
        'font:11px/1.4 monospace;color:#ffb84d;opacity:0.85;text-shadow:0 1px 2px #000;' +
        'background:rgba(0,0,0,0.35);padding:3px 7px;border-radius:4px;';
      document.body.append(badge);
    }
    badge.textContent = `⟳ ${stale} file${stale === 1 ? '' : 's'} changed — Ctrl+R`;
  });
}

// Auto-start: init immediately, overlay stays hidden until ESC is pressed
// The clip feed is phone-first — the desktop-required gate must not
// block it (playback needs no keyboard/mouse).
if (!feedMode.on) {wireOnboarding();}
init().then(async (): Promise<void> => {
  gameStarted = true;

  if (feedMode.on) {
    const { startClipFeed } = await import('./feed/clipFeed.js');
    await startClipFeed({ demoManager: demoManager!, hud, overlay, canvas: renderer.domElement,
      renderNow: (): void => renderer.render(scene, camera) });
    return;
  }

  // Fetch cool shots from server so they're shown in the initial overlay
  // (the feed path above fetches for itself and exits early).
  demoManager?.fetchCoolShotsFromServer();

  // F9 = ShadowPlay-style canvas recorder: WebCodecs/NVENC when available,
  // MediaRecorder fallback, canvas-only (HUD never enters the clip).
  document.addEventListener('keydown', (e): void => {
    if (e.code !== 'F9' || e.repeat) {return;}
    demoManager?.toggleVideoRecord();
  });

  // Desync debugging (snapshot/hash comparison + window debug functions) —
  // dev-only or ?debug, dynamically imported so it stays out of the prod
  // bundle. Runs at boot when the flag is set, and again if the menu DEBUG
  // toggle flips on mid-session (fps:set event) — no reload needed.
  let debugWired = false;
  const wireDebugTools = async (): Promise<void> => {
    if (debugWired) {return;}
    debugWired = true;
    if (networkManager) {
      const { wireStateDebug } = await import('./core/stateDebug.js');
      wireStateDebug({
        networkManager,
        getPlayer: (): Player => player,
        remotePlayers: world.remotePlayers,
        projectiles: world.projectiles,
        getLastSentPos: remotes.getLastSentPos,
        world,
        teamBots: (): TeamBots | null => teamBots,
        getScene: (): THREE.Scene<THREE.Object3DEventMap> => scene,
        getCamera: (): THREE.PerspectiveCamera => player.camera,
        netCreatures: () => [
          ...entities.crawlers, ...entities.scarabs, ...entities.rakks, ...entities.rollers,
          ...entities.gnats, ...entities.snakes, ...entities.banelings, ...entities.totems,
        ],
        netDeployables: () => entities.deployables.netEntries(),
        logger,
      });
    }
    // Headless/probe hook — the puppeteer scripts in headless-test drive off
    // this (spawn PlayerModels, read player.pos, aim the camera).
    window.__test = {
      player, scene, entities, world, terrain, viewModel,
      networkManager, demoManager, rendererSetup, demoLifecycle,
      chatSink: (await import('./game/chat.js')).chatSink,
    };
    // .rec captures (gauntlet --record / pvptest record.ts) replay through
    // the live dispatch as gameplay: __playRec('/hunt.rec', 1.5)
    window.__playRec = async (src, speed): Promise<() => void> =>
      (await import('./dev/recPlayer.js')).playRec(networkManager, src, speed);
  };
  // Debug wiring (window.__test, __playRec, stateDebug) — dev hosts only.
  if (isDevHost() && (import.meta.env.DEV || urlParams.debug)) {await wireDebugTools();}
  // In-game log mirror — subscribes to Logger once so every later line
  // (and the Alt+Q/backquote/DEBUG-toggle reveals) has a live feed.
  initLogPanel();
  installOverlapAudit();
  // Revealing the log panel reshuffles the corner stack — audit the
  // layout once the reveal frame lands.
  window.addEventListener('fps:altq', (): number =>
    requestAnimationFrame((): number => requestAnimationFrame(reportHudOverlap)));
  window.addEventListener('fps:set', (e): void => {
    const { key, value } = (e as CustomEvent<{ key: string; value: unknown }>).detail;
    if (key === 'fps-debug' && value === 1 && isDevHost()) {wireDebugTools();}
  });
return; }).catch((): void => undefined);
