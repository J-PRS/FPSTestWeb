// oxlint-disable-next-line import/no-unassigned-import
// oxlint-disable-next-line import/no-unassigned-import
import pkg from '../package.json';
// oxlint-disable-next-line import/no-unassigned-import
import './core/polyfills.js'; // toSorted etc. - older engines
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
import { simRngSeed, lcg32 } from '../../shared/simRand.js';
import { spawnRngSeed } from '../../shared/spawnDice.js';
import { botRng } from '../../shared/botRand.js';
import { setRunSeed, mintSeed, getChallenge, fetchChallenge } from './demo/demoSeed.js';
import { watchDeployVersion, checkDeployNow } from './core/deployWatch.js';
import { noteStale, staleCount } from './core/staleFiles.js';
import { createRenderer, GAME_ASPECT } from './core/renderer.js';
import * as sfx from './core/sfx.js';
import { audio } from './core/audio.js';

import { DemoManager } from './demo/index.js';
import { playerProviders } from './demo/playerProviders.js';

import { Player } from './entities/Player.js';
import { RIG_MANIFEST, CLASS_BODY_VARIANT } from './entities/playerClips.js';
import { ATLAS_BLACK, type PlayerModelVariant } from './entities/PlayerModel.js';
import type { ViewModel } from './entities/ViewModel.js';

import { DamageNumberManager } from './effects/damageNumbers.js';
import { PlayerDebris } from './effects/debris.js';
import { EffectsManager } from './effects/effects.js';
import { initVfx } from './effects/vfx.js';
import { SpeedLines } from './effects/speedLines.js';
import { AmbientWeather } from './effects/ambientWeather.js';
import { GroundMist } from './effects/groundMist.js';
import { AmbientBirds } from './effects/birds.js';

import { resolveServerEndpoints, fleetWorkerUrl, NAMED_SERVERS } from './networking/endpoints.js';
import { NetworkManager } from './networking/NetworkManager.js';
import { connectServer } from './networking/connectServer.js';
import { CoolShotsPanel } from './ui/CoolShotsPanel.js';
import { FragMessages } from './ui/FragMessages.js';
import { HealthBarSystem } from './ui/HealthBarSystem.js';
import { HUD } from './ui/hud.js';
import { wireOverlayInput } from './ui/overlayInput.js';
import { initLogPanel } from './ui/logPanel.js';
import { installOverlapAudit, reportHudOverlap } from './ui/overlapAudit.js';

import { effectiveResist } from '../../shared/perks.js';
import { MOVEMENT_CONFIG } from '../../shared/movement.js';
import { REPAIR_HEAL_PER_TICK } from '../../shared/weapons.js';

import { applyDebugHooks } from './game/debugHooks.js';
import { createWorldState } from './game/worldState.js';
import { createCombat } from './game/combat.js';
import { TeamBots } from './game/bots/index.js';
import type { GameBot } from './game/bots/botBrain.js';
import { SoloConquest } from './game/soloConquest.js';
import { HM_WORLD_SCALE } from '../../shared/heightfield.js';
import { MODES , type ModeId, TEAM_COLORS } from '../../shared/teams.js';
import { firstTerrain, probeBootMap, bootPrimeTerrain, bootPrimedPreset, bootApplySavedMap, armSessionVeil, type MapSnapshot } from './game/net/world.js';
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
import { setBootVeil } from './ui/hud/hudChrome.js';
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

// Ambient particle weather — one owner for the dust/embers/ash/snow layers;
// the room's map spec picks which drift (absent = the default trio).
const ambientWeather = new AmbientWeather(scene);
// oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
let groundMist!: GroundMist; // needs terrain — created in init()
const ambientBirds = new AmbientBirds(scene); // kettle of buzzards on a thermal

// ---- Renderer ----
const rendererSetup = createRenderer(camera, scene);
const { renderer } = rendererSetup;
renderer.setClearColor(FOG_COLOR);

// Environment probe — one-time PMREM bake of the scene's sky/atmosphere
// so MeshStandardMaterial has real reflections. Without it metal armor
// reflects void and reads dead-black; the bake is a few ms at boot, then
// every standard material picks it up free (no per-frame cost).
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(scene, 0.06).texture;
  pmrem.dispose();
}

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
let soloConquest: SoloConquest | null = null; // ?mode=conquest — the offline lattice
const _conqSpawn = new THREE.Vector3();

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
// Ranked-solo challenge — minted by the backend so runSeed isn't self-
// chosen. Entity boot awaits it with a bound so ranked runs bind
// deterministically; a dead backend degrades to local mint (unranked).
const challengeReady = serverEndpoints.then(ep => fetchChallenge(ep.httpUrl)).catch(() => {});
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
    weather: ambientWeather,
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
  player.onSkillUse = (): void => networkManager.sendSkillUse(player.skill);
  networkManager.joinSkill = (): string => player.skill;
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
  // Own-corpse gib — the same burst remote victims get. Fires on every
  // death edge; in FP it's mostly hidden, but the kill-cam dwells on the
  // spot and a chase-cam death needs it to not freeze mid-pose.
  player.onLocalDeath = (): void => {
    let parts;
    try { parts = player.model?.deathParts() ?? undefined; }
    catch { parts = undefined; }
    world.playerDebrisList.push(new PlayerDebris(
      scene, terrain,
      { x: player.pos.x, y: player.pos.y - 0.6, z: player.pos.z },
      ATLAS_BLACK ? new THREE.Color(0x11_11_11) : new THREE.Color(world.localTeam ? TEAM_COLORS[world.localTeam] : 0x88_99_AA),
      { inheritVel: player.vel, parts, shardGeos: parts?.map((p) => p.geo) },
    ));
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
  // Fall damage — the sim's T1 impact read. Dressing fires in MP too
  // (the land thud's -vel.y scale can't see slope/wall slams; cover the
  // gap or a 20%-bar splat sounds like a footstep). The featherfall
  // soak runs everywhere so the local tank mirrors the shadow's drain —
  // only the health write is offline-only (wire owns it in MP).
  player.onFallDamage = (impact, vImp): void => {
    const gap = Math.max(0, impact - vImp);
    if (gap > 0) {sfx.land(gap); player.model?.landPulse(gap);}
    effects.spawnSlamDust(player.pos, impact);
    const frac = (impact - MOVEMENT_CONFIG.fallDamageMinSpeed) * MOVEMENT_CONFIG.fallDamageScale;
    let raw = frac * player.maxHealth;
    const soak = player.mods.fallSoak;
    if (soak > 0 && player.energy > 0) {
      const covered = Math.min(raw, player.energy * soak);
      player.energy -= covered / soak;
      raw -= covered;
      if (covered > 0.01) {sfx.shieldHit();} // the tank took the punch
    }
    // Under a tenth of the bar the landing is a shrug, not a wound —
    // the dust/thud above already sold the impact.
    if (raw < player.maxHealth * MOVEMENT_CONFIG.fallDamageAbsorbFrac) {return;}
    if (player.isDead || (player.serverOwnsHealth?.() ?? false)) {return;}
    const dmg = Math.max(1, Math.round(raw * (1 - effectiveResist(player.mods, player.health, player.maxHealth))));
    player.health = Math.max(0, player.health - dmg);
    player.lastDamageSource = 'hard landing';
    hud.showDamage(player.pos, dmg);
    sfx.playerHurt();
    if (player.health <= 0) { teamBots?.localDied(); killLocal('fell to death'); }
  };
  // The handshake carries the LIVE tier/perk (applied*), not the menu
  // pick: a reclaim applies the claim to the seat immediately, so
  // sending a banked pick would enforce a class the client isn't
  // playing yet (class-locked rejects until respawn).
  networkManager.joinPerk = () => player.appliedPerk;
  networkManager.joinClass = (): "light" | "medium" | "heavy" => player.appliedClass;
  // Kill zone — the body dropped below the map's floor. Predicted locally
  // so the death lands on the crossing frame; the server's shadow owns
  // the actual kill and the respawn.
  player.onKillZone = (): void => {
    if (player.isDead) {return;}
    killLocal('fell out of the arena');
  };
}



// Player→HUD/viewmodel status hooks + the wildlife truce table.
function wirePlayerStatusHooks(): void {
  // Ambient buzzards are decor only — the REAL buzzards are server-owned
  // creatures (species 'buzzard', map `creatures` pops) that hunt whoever
  // shot them. This kettle stays out of entities.targets on purpose: two
  // shootable flocks would double the population and resurrect the
  // self-only aggro bug the creature sim fixes.

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
  // One seed per run — simRand drives all sim-truth dice (wave picks,
  // spawn placement, spread, bomblets); botRand gets a sibling stream so
  // offline bots replay identically too. The demo header stamps the seed
  // so a verifier can walk the identical dice sequence.
  const runSeed = getChallenge()?.seed ?? mintSeed();
  simRngSeed(runSeed);
  spawnRngSeed(runSeed);
  botRng(lcg32(runSeed ^ 0x5A_17_9E_37));
  setRunSeed(runSeed);
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
    onNuggetCollect: (id, kind, val): void | undefined => teamBots?.collect(id, kind, val),
    lazyCombat: () => combat,
    deployEnemyBots: (): { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; }[] => teamBots?.enemyBotsForLocal() ?? [],
    deployBotFoes: (team) => teamBots?.enemyBotsForTeam(team) ?? [],
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
      dropNuggets: (pos, n, vel, kind, val): void => entities.spawnNuggetsAt(pos, n, vel, kind, val),
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
          if (d >= bd) {continue;}
          // Headhunt: value out-pulls proximity — a purple spill shrinks
          // its effective distance up to 70%, so fat coins draw the
          // lobby while 1-coins stay opportunism. Plain nuggets (val 1)
          // price out essentially unchanged.
          const eff = d * (1 - Math.min(n.val, 27) / 27 * 0.7);
          if (eff < bd) { bd = eff; best = n; }
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
      hostileGear: (team, pos, range) => entities.deployables.hostileGear(team, pos, range),
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
    player.resetLifeState(); // banked class + HP pool — was default-100 bug
    player.pos.set(spot.x + 3, terrain.getHeight(spot.x + 3, spot.z + 3) + 2, spot.z + 3);
    noteLocalSnap();
    player.syncMovement();
    player.markTeleport();
  }
  // Conquest — the same ConquestSim the Room hosts, driven by local
  // state. Bots were seated at authored spawns before the lattice knew
  // its rings, so reseat them at their cores (Room's initial seating).
  if (mode === 'conquest') {
    soloConquest = new SoloConquest({
      world, scene,
      lazyPlayer: (): Player => player,
      lazyTerrain: (): Terrain => terrain,
      lazyNetworkManager: (): NetworkManager => networkManager,
      lazyHud: (): { setTeamScore?(a: number, b: number): void } => hud,
      setNodeSpawns: (rings): void => { if (teamBots) {teamBots.nodeSpawns = rings;} },
      teamOfBot: (id): string | undefined => teamBots?.teamOf.get(id),
      bots: (): GameBot[] => teamBots?.bots ?? [],
      setWinner: (t): void => { if (teamBots) {teamBots.conquestWin = t;} },
      setTeamScores: (a, b): void => {
        if (teamBots) {teamBots.scores.alpha = a; teamBots.scores.bravo = b;}
        world.teamScores = { alpha: a, bravo: b };
      },
    }, mapSpec?.conquest?.span ?? mapSpec?.tileSize ?? HM_WORLD_SCALE, mapSpec?.conquest?.n);
    teamBots.conquest = soloConquest;
    world.soloConquest = soloConquest;
    teamBots.reseatAll();
    const p = soloConquest.spawnSpot('alpha', _conqSpawn);
    player.resetLifeState();
    player.pos.set(p.x, terrain.getHeight(p.x, p.z) + 2, p.z);
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
  if (!classicMode && soloMode && soloSpec && soloSpec.spec.killY === undefined) {
    seatKits(soloSpec.spec.structures, (x, z): number => terrain.getHeight(x, z));
  }
  if (!classicMode) {bootApplySavedMap(netCtx, soloMode ? (soloSpec?.map ?? null) : savedMap);}
  profiler.markTime('savedMapApplied');
  const serverUrl = (await serverEndpoints).wsUrl;
  logger.info(`[diag] serverUrl=${serverUrl} classic=${classicMode || soloMode}`);
  // Pin a resolved remote server into the URL so refresh can't drop back
  // to localhost. Named servers get the pretty /<alias>/<room> path;
  // anything else falls back to ?server=. Local hosts stay unpinned —
  // a shared link must never hardcode ws://127.0.0.1 for its opener.
  {
    // Pin the ENTRY host, not the seat: on a fleet, wsUrl is the assigned
    // worker (host:8443) - alias-matching it misses NAMED_SERVERS and
    // stamps ?server=wss://host:8443 into the bar, which both stays ugly
    // and pins share recipients to one worker, bypassing matchmaking.
    // lobbyUrl is the matchmaker a fresh joiner must enter through.
    const pinBase = (await serverEndpoints).lobbyUrl ?? serverUrl;
    const u = new URL(pinBase);
    const local = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(u.hostname);
    // A ?server= that already names the entry host is redundant - it
    // only ever needed the param to SAY it. Those get the alias path
    // too (and drop the param), which self-heals stamped worker URLs
    // from before this ran against the entry host.
    const serverParam = urlParams.get('server');
    const serverParamHost = ((): string => { try { return new URL(serverParam ?? '').host; } catch { return ''; } })();
    const redundantParam = Boolean(serverParam) && (serverParamHost === u.host || serverParamHost === serverUrlHost());
    function serverUrlHost(): string { try { return new URL(serverUrl).host; } catch { return ''; } }
    if (!local && (!urlParams.has('server') || redundantParam) && !urlParams.serverPath) {
      const alias = Object.entries(NAMED_SERVERS).find(([, v]): boolean => {
        try { return new URL(v).host === u.host; } catch { return false; }
      })?.[0];
      const q = new URLSearchParams(window.location.search);
      if (redundantParam) {q.delete('server');}
      const search = q.size > 0 ? `?${q}` : '';
      if (alias && window.location.pathname.startsWith('/s/')) {
        history.replaceState(null, '', `/${alias}${window.location.pathname.slice(2)}${search}`);
      } else if (!alias) {
        if (!serverParam) {q.set('server', `${u.protocol}//${u.host}`);}
        history.replaceState(null, '', `${window.location.pathname}${q.size > 0 ? `?${q}` : ''}`);
      }
    }
  }
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
      if (await pingServer((await serverEndpoints).httpUrl)) {armSessionVeil('RECONNECTING', (): void => networkManager.sendReady());}
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
      player.resetLifeState();
      player.pos.set(anchor.x, Math.max(anchor.y, terrain.getHeight(anchor.x, anchor.z) + 2), anchor.z);
      player.yaw = Math.atan2(-anchor.x, -anchor.z);
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
  // Defer a deploy reload to the only real break: the intermission —
  // match clock expired, scoreboard up, next match not started.
  // Menu/death are still live play. Grace cap inside bounds the wait.
  // Version footer — /build.txt (content hash + stamp, written by the
  // dist-size plugin every build). version.txt is the deploy watcher’s
  // stamp; build.txt is WHICH bundle this is.
  fetch('/build.txt', { cache: 'no-cache' })
    .then((r) => r.ok ? r.text() : '')
    .then((v) => {
      const el = document.getElementById('client-ver'); if (!el) {return;}
      const [hash, stamp] = v.trim().split(/\s+/);
      el.textContent = `v${pkg.version} · ${hash ?? 'dev'}${stamp ? ` · ${stamp}` : ''}`;
    })
    .catch((): void => { /* no build.txt on a bare dev serve — fine */ });
  watchDeployVersion({ whenIdle: (): boolean =>
    world.matchEndsAt !== null && world.matchEndsAt <= Date.now() });
  networkManager = new NetworkManager();
  // Deploy admission gate — every join/reconnect (initial dial, stall
  // retries) first checks version.txt; a new build reloads BEFORE this
  // client is admitted, so stale tabs migrate at their natural join
  // moment instead of being rejected mid-protocol by a drifted wire.
  networkManager.onPreConnect = checkDeployNow;
  networkManager.armWireQueue();
  // /quickjoin — ask the matchmaker for a seat before anything reads
  // urlParams; the picked room lands as the canonical /s/<room> path, so
  // the whole boot below just sees an ordinary online join. Failure
  // leaves the path alone → normal menu boot.
  if (/^\/(quickjoin|quickplay)\/?$/.test(window.location.pathname)) {
    try {
      const { httpUrl } = await serverEndpoints;
      const q = new URLSearchParams(window.location.search);
      q.set('humans', '1');
      const res = await fetch(`${httpUrl}/join?${q}`, { cache: 'no-cache' });
      if (res.ok) {
        const { room } = (await res.json()) as { room: string };
        if (room) {history.replaceState(null, '', `/s/${encodeURIComponent(room)}${window.location.search}`);}
      }
    } catch { /* offline or matchmaker down — menu boot owns it */ }
  }
  // Invite completeness: a room joined via the lobby's saved fps-server
  // pick carries no ?server= in the URL — sharing /s/<room> would land
  // friends on THEIR default host, where the room doesn't exist. Mirror
  // the saved host into the search so the address bar is always the full
  // invite. An explicit ?server= link already carries it and wins; an
  // empty setting is the default host (a public deploy's server.json
  // resolves identically for the recipient — nothing to carry).
  if (!urlParams.get('server') && settings.get('fps-server').trim()) {
    const q = new URLSearchParams(window.location.search);
    q.set('server', settings.get('fps-server').trim());
    history.replaceState(null, '', `${window.location.pathname}?${q}`);
  }
  // Boot resume: a bare '/' load with a remembered room rejoins it — the
  // canonical /s/<room> path is written BEFORE anything reads urlParams,
  // so every downstream consumer (early wire, join payload, lobby) sees
  // the resumed identity. Explicit leaves clear fps-last-room, so its
  // presence means "was in a match and never left". A solo pick
  // (fps-solo) suppresses the resume — the player chose offline.
  // Bare '/' ONLY — a public-pool path (/quickplay|/quickjoin) whose
  // matchmaker call didn't land must NOT resume a stale last-room
  // (that hijack is exactly 'quickplay puts me in arena-1').
  if (window.location.pathname === '/' && !urlParams.room && !urlParams.p2p && !urlParams.solo && settings.get('fps-last-room')) {
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
  // Classic is a solo ruleset — its connect veto only holds offline.
  // A persisted fps-mode=classic must not survive an explicit /s/ join.
  const classicBlocksWire = urlParams.mode === 'classic' && !urlParams.room && !urlParams.p2p;
  const earlyWire = Boolean(urlParams.room) && !urlParams.p2p && !classicBlocksWire;
  // Cold QUIC first-dial costs ~2.5-3.2s and only a COMPLETED handshake
  // unlocks resumption — a boot-time warm dial finishes after the real
  // probe already started, so the cap raise (4.5s) is the actual fix.
  // A racing warm dial was measured to just contend.
  if (onlineBoot && !classicBlocksWire && settings.get('fps-session-token')) {
    serverEndpoints
      .then((ep): Promise<boolean> => pingServer(ep.httpUrl))
      .then((live): void => { if (live) {armSessionVeil('RECONNECTING', (): void => networkManager.sendReady()); profiler.markTime('veilProbed');} return; })
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
  // The veil covers EVERY online boot, not just token restores — a
  // fresh join renders frames from the unspawned player position during
  // connect→gameState→spawnAssign, and that gap reads as a flash under
  // the terrain. Drop path is identical (gameState + terrain + stable
  // frames; 8s escape on connect failure).
  if (onlineBoot && urlParams.mode !== 'classic') {
    // The server holds the body off-spawn until 'ready' — the veil-drop
    // callback IS the release (stable frames or the 8s force timer).
    armSessionVeil(settings.get('fps-session-token') ? 'RECONNECTING' : 'JOINING', (): void => networkManager.sendReady());
  }
  // Warm the class-body GLB into the HTTP cache — the loader's fetch at
  // playerCtor then hits cache instead of a cold fetch starting ~1.5s
  // into init. Saved class pick wins, else the medium default. Remotes
  // may differ but share the manifest's small set.
  {
    const bootClass = settings.get('fps-class') || 'medium';
    const bootUrl = RIG_MANIFEST[(CLASS_BODY_VARIANT[bootClass] ?? 'vexa') as PlayerModelVariant]?.url;
    if (bootUrl) {void fetch(bootUrl).catch((): void => undefined);}
  }
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
  // Fresh-join terrain prime: ?room=X learns its map from the public
  // /rooms lobby list — the heightfield fetch then rides the dial
  // instead of serializing inside the veil (the ~2.7s
  // gameState→terrainSwapped gap). fieldLoaded marks it resident so
  // applyTerrain skips the refetch. Only heights are primed — tex/sky/
  // interiors still apply at gameState as before.
  let roomPrimed = false;
  if (!soloPrimed && !bootSaved && onlineBoot && urlParams.room) {
    try {
      const { httpUrl } = await serverEndpoints;
      const rooms = await (await fetch(`${httpUrl}/rooms`)).json() as { name: string; map?: string }[];
      const mine = rooms.find((r): boolean => r.name === urlParams.room);
      // Spec JSON first: the resolved spec carries terrainPreset +
      // heightScale so the primed field is exactly right AND the boot
      // program compiles the real palette (bootPrimedPreset seeds
      // setPreset before the tick-60 warmup). Bin-only fallback keeps
      // the old behavior when the spec route misses.
      if (mine?.map) {
        const hit = await loadSoloSpec(mine.map);
        roomPrimed = hit
          ? await bootPrimeTerrain(httpUrl, hit.map)
          : await bootPrimeTerrain(httpUrl, { terrain: `${mine.map}.bin` });
      }
    } catch { roomPrimed = false; }
  }
  if (!soloPrimed && !roomPrimed && (!bootSaved || !(await bootPrimeTerrain(bootSaved.httpUrl, bootSaved.map)))) {
    await loadHeightfieldBin('/assets/heightmaps/heightmap.bin');
  }
  profiler.markTime('heightmapLoaded');

  terrain = new Terrain(scene, sun.position.clone().normalize());
  // A primed field (solo ?map= / saved-room probe) already carries its
  // gain in hmScale — the fresh Terrain built its uniforms at 1x.
  applyHeightfieldScale(terrain);
  // Seed the primed map's palette BEFORE the tick-60 warmup compile —
  // the boot program then IS the map's preset, so applyTerrain's
  // setPreset never recompiles (~1s serial stall inside the veil).
  const primedP = bootPrimedPreset();
  if (primedP !== null) {terrain.setPreset(primedP);}
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
      player.resetLifeState();
      player.pos.set(a0.x, Math.max(a0.y, terrain.getHeight(a0.x, a0.z) + 2), a0.z);
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

  // Ranked-solo: give the minted seed a bounded window to land — a run
  // that started before it arrived would verify nothing anyway.
  await Promise.race([challengeReady, new Promise((r): void => { setTimeout(r, 1500); })]);
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
  const classicMode = mode === 'classic' && !urlParams.room && !urlParams.p2p;
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
      // A ?room/?p2p link must NEVER spawn the local roster — isConnected()
      // is transiently false through every transport reprobe, and a stall
      // coinciding with this gate would seed offline bots into a live
      // online room that no gameState ever retires again.
      .then(async (): Promise<void> => { await gameLoop?.whenStable(); if (!teamBots && !networkManager.isConnected() && mode && !urlParams.room && !urlParams.p2p) {setupOfflineMode(mode, soloSpec?.spec);} return; }).catch((): void => undefined);
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
  if (mode === 'nuggets' || mode === 'ctf' || mode === 'flagrun' || mode === 'conquest') {hud.setTeamScore(0, 0);}
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
    lazyWeather: (): AmbientWeather => ambientWeather,
    lazyPlayer: (): Player => player,
    lazyEffects: (): EffectsManager => effects,
    lazyHud: (): HUD => hud,
    lazyHealthBarSystem: (): HealthBarSystem => healthBarSystem,
    lazyDamageNumbers: (): DamageNumberManager => damageNumberManager,
    lazyCamera: (): THREE.Camera => camera,
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
  if (classicMode || (!urlParams.room && !urlParams.p2p)) {player.freezeInput(); setBootVeil(true);}
  else {setBootVeil(false);}
  gameLoop.start();
  // Offline clip renderer drives real render passes off the rAF cadence.
  if (demoManager) {demoManager.renderNow = (dt: number): void => gameLoop.renderFrame(dt);}

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
    lazyNetworkManager: (): NetworkManager => networkManager,
    lazyWeather: (): AmbientWeather => ambientWeather,
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
    buzzards: entities.buzzards,
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
  // Predicted-death un-brick can revive us before the killLocal timer
  // fires — a teleport on a living player is worse than a missed revive.
  if (!player.isDead) {return;}
  player.resetLifeState();
  // Conquest respawns on owned territory — the node-linked rule the
  // server's teamSpawns mint applies here too (cores always count).
  const conqSpot = (world.localTeam === 'alpha' || world.localTeam === 'bravo')
    ? soloConquest?.spawnSpot(world.localTeam, _conqSpawn) : undefined;
  const spot = teamBots?.flagrun?.spawnPoint() ?? conqSpot;
  // Spec maps respawn at authored anchors (team spawn > generic spawn >
  // own base) — same priority as the solo boot spawn.
  const specAnchor = soloSpec?.spec.teamSpawns?.alpha?.[0] ?? soloSpec?.spec.spawns?.[0] ?? soloSpec?.spec.bases?.alpha;
  if (spot) {
    player.pos.set(spot.x + 3, terrain.getHeight(spot.x + 3, spot.z + 3) + 2, spot.z + 3);
  } else if (specAnchor) {
    player.pos.set(specAnchor.x, Math.max(specAnchor.y, terrain.getHeight(specAnchor.x, specAnchor.z) + 2), specAnchor.z);
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
let staleBadge: HTMLDivElement | null = null;
const paintStaleBadge = (): void => {
  const stale = staleCount();
  if (!staleBadge) {
    staleBadge = document.createElement('div');
    staleBadge.id = 'stale-badge';
    staleBadge.style.cssText =
      'position:fixed;bottom:8px;right:10px;z-index:9999;pointer-events:none;' +
      'font:11px/1.4 monospace;color:#ffb84d;opacity:0.85;text-shadow:0 1px 2px #000;' +
      'background:rgba(0,0,0,0.35);padding:3px 7px;border-radius:4px;';
    document.body.append(staleBadge);
  }
  staleBadge.textContent = `⟳ ${stale} file${stale === 1 ? '' : 's'} changed`;
  staleBadge.style.display = stale ? '' : 'none'; // a 0 badge is noise
};
// Preview/prod badge: the vite 'stale-probe' plugin serves /dev/stale
// (files newer than the dist build stamp) — localhost-only so the same
// bundle on a tunneled https URL stays clean. Count is absolute vs
// build, not cumulative — feed the delta into the accumulator.
if (import.meta.env.PROD && (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]')) {
  // Alt+R = rebuild + reload — the loop the preview badge makes visible.
  let rebuildDiv: HTMLDivElement | null = null;
  const rebuild = (): void => {
    if (!rebuildDiv) {
      rebuildDiv = document.createElement('div');
      rebuildDiv.style.cssText =
        'position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);z-index:99999;' +
        'font:14px monospace;color:#ffb84d;background:rgba(0,0,0,0.75);padding:10px 16px;border-radius:6px;';
      rebuildDiv.textContent = '⟳ rebuilding…';
      document.body.append(rebuildDiv);
    }
    fetch('/dev/rebuild', { method: 'POST' })
      .then((r) => { if (r.ok) {location.reload();} else {rebuildDiv!.textContent = `rebuild failed (${r.status})`;} })
      .catch((): void => { rebuildDiv!.textContent = 'rebuild endpoint missing'; });
  };
  addEventListener('keydown', (e: KeyboardEvent): void => {
    if (!e.altKey || e.code !== 'KeyR' || e.repeat) {return;}
    e.preventDefault();
    rebuild();
  });
  // Alt-tab away = "I'm done editing for now": if the badge would show
  // stale files, rebuild in the background so the bundle is fresh on
  // return. Blur alone costs nothing when nothing changed.
  addEventListener('blur', (): void => {
    fetch('/dev/stale')
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d && d.count > 0) {rebuild();} })
      .catch((): void => { /* no stale probe - do nothing */ });
  });
  let lastCount = 0;
  const applyStale = (d: { count: number; files?: string[]; built?: number } | null): void => {
    if (!d || d.count === lastCount) {return;}
    noteStale(d.files, d.count - lastCount);
    lastCount = d.count;
    paintStaleBadge();
  };
  const poll = (): void => {
    fetch('/dev/stale')
      .then((r) => r.ok ? r.json() : null)
      .then(applyStale)
      .catch((): void => { /* endpoint absent on real prod — stay silent */ });
  };
  poll();
  // Push when the preview exposes it (fs.watch → SSE); fall back to a
  // poll if the endpoint isn't there (older preview / real prod).
  const es = new EventSource('/dev/stale-events');
  es.onmessage = (e): void => {
    try { applyStale(JSON.parse(e.data)); } catch { /* malformed push */ }
  };
  es.onerror = (): void => {
    es.close();
    setInterval(poll, 4000);
  };
}
const hot = import.meta.hot as unknown as { on(e: string, cb: (d: { count: number; files?: string[] }) => void): void } | undefined;
if (hot) {
  hot.on('stale:changed', (d): void => {
    noteStale(d.files, d.count);
    paintStaleBadge();
  });

  // dev-watch restart countdown: the watcher exposes the armed restart on
  // the seat-handoff port (server http port + 1) — its save debounce +
  // drain is otherwise invisible until the socket dies mid-fight.
  {
    let rbadge: HTMLDivElement | null = null;
    let restartAt = 0;
    const paint = (): void => {
      const left = restartAt - Date.now();
      if (left <= -15_000) {restartAt = 0;} // countdown passed and we're still alive — drop it
      if (!restartAt) {if (rbadge) {rbadge.style.display = 'none';} return;}
      if (!rbadge) {
        rbadge = document.createElement('div');
        rbadge.style.cssText =
          'position:fixed;bottom:26px;right:10px;z-index:9999;pointer-events:none;' +
          'font:11px/1.4 monospace;color:#ff6b6b;opacity:0.9;text-shadow:0 1px 2px #000;' +
          'background:rgba(0,0,0,0.35);padding:3px 7px;border-radius:4px;';
        document.body.append(rbadge);
      }
      rbadge.style.display = '';
      rbadge.textContent = left > 0 ? `⟳ server restart in ${(left / 1000).toFixed(1)}s` : '⟳ server restarting…';
    };
    setInterval(paint, 200);
    const pollRestart = async (url: string): Promise<boolean> => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        restartAt = r.ok ? Number((await r.json() as { restartAt?: number }).restartAt ?? 0) : 0;
        return true;
      } catch { restartAt = 0; return false; } // bare `bun src/server.ts` — no watcher to announce
    };
    const armRestartPoll = async (): Promise<void> => {
      const ep = await serverEndpoints;
      const u = new URL(ep.httpUrl);
      if (u.protocol !== 'http:' || !u.port) {return;} // dev-watch only exists on the http dev server
      u.port = String(Number(u.port) + 1);
      const url = `${u.origin}/restart`;
      let fails = 0;
      // pending window is ~3s — coarse polling would miss it. Spawned test
      // servers and prod have no dev-watch: refused forever, so a few straight
      // failures stop the poll instead of spamming console for the session.
      const t = setInterval(async (): Promise<void> => {
        fails = (await pollRestart(url)) ? 0 : fails + 1;
        if (fails >= 8) {clearInterval(t);}
      }, 500);
    };
    armRestartPoll().catch((): undefined => undefined);
  }
}

// Auto-start: init immediately, overlay stays hidden until ESC is pressed
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
  // bundle (and out of main.ts — the file is size-pinned). Runs at boot
  // when the flag is set, and again if the menu DEBUG toggle flips on
  // mid-session (fps:set event) — no reload needed.
  // devtoolsOn is the STATIC half of the gate: a runtime isDevHost()
  // alone still emits the chunk into dist/. Prod builds drop devTools
  // entirely (window.__test lives there - e2e always runs npm run dev);
  // VITE_FPS_DEVTOOLS=1 opts a prod build back in.
  const devtoolsOn = import.meta.env.DEV || import.meta.env.VITE_FPS_DEVTOOLS === '1';
  const wireDebugTools = (): Promise<void> => import('./dev/devTools.js').then(m =>
    m.wireDebugTools({ networkManager, player, world, entities, terrain, viewModel, demoManager,
      rendererSetup, demoLifecycle, scene, remotes, teamBots, logger, hud }));
  // Debug wiring (window.__test, __playRec, stateDebug) — dev hosts only.
  if (devtoolsOn && isDevHost() && (import.meta.env.DEV || urlParams.debug)) {await wireDebugTools();}
  // In-game log mirror — subscribes to Logger once so every later line
  // (and the Alt+Q/backquote/DEBUG-toggle reveals) has a live feed.
  initLogPanel();
  // Same feed drives the conn-banner complaint slot — dev hosts only:
  // parity/ghost-shell jargon means nothing on the public deploy, where
  // the banner should only ever read CONNECTED / CONNECTION LOST.
  if (isDevHost()) {Logger.setComplaintListener((line): void => { hud.complaint(line); });}
  installOverlapAudit();
  // Revealing the log panel reshuffles the corner stack — audit the
  // layout once the reveal frame lands.
  window.addEventListener('fps:altq', (): number =>
    requestAnimationFrame((): number => requestAnimationFrame(reportHudOverlap)));
  window.addEventListener('fps:set', (e): void => {
    const { key, value } = (e as CustomEvent<{ key: string; value: unknown }>).detail;
    if (key === 'fps-debug' && value === 1 && devtoolsOn && isDevHost()) {wireDebugTools();}
  });
return; }).catch((): void => undefined);
