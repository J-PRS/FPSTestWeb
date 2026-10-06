import * as THREE from 'three';

import { BALL_SPAWN_INTERVAL, BALL_MAX } from '../core/config.js';
import { urlParams } from '../core/params.js';
import * as sfx from '../core/sfx.js';
import { createNetBalls } from './netBalls.js';
import { createNetCrawlers } from './netCrawlers.js';
import { createSpeciesKit } from './speciesKit.js';
import { PROFILES } from './targeting.js';
import { Ball, pickVariant, type Targetable } from '../entities/balls.js';
import { Nugget } from '../entities/Nugget.js';
import type { GameContext } from './context.js';
import { Deployables } from './deployables.js';
import { createMeleeSpecies } from './species/melee.js';
import { createFlyerSpecies } from './species/flyers.js';
import { createSiegeSpecies } from './species/siege.js';
import { createAmbientSpecies } from './species/ambient.js';

export interface EntitiesDeps extends GameContext {
  // scene/camera exist before entities is constructed — eager refs, no lazy needed
  scene: THREE.Scene;
  camera: THREE.Camera;
  // Playback balls are owned by demoLifecycle — updateBalls defers to it
  updateBallsPlayback: (dt: number) => void;
  /** Nugget Wars: extra collectors (bots) nuggets magnet toward, plus a
   *  callback so each pickup banks on the right team. Absent = solo mode,
   *  the player is the only collector. */
  nuggetCollectors?: () => { id: string; pos: THREE.Vector3; alive: boolean; pickupScale?: number }[];
  onNuggetCollect?: (collectorId: string) => void;
  /** Deployables: combat resolves after entities is built — lazy getter. */
  lazyCombat?: () => { hitTargetLocal(t: Targetable, dmg: number, attackerId?: string): boolean } | undefined;
  /** Enemy bots deployable turrets may shoot (deployer's team excluded). */
  deployEnemyBots?: () => { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[];
  /** Hostiles of a given team — a bot-owned turret/mine scans these. */
  deployBotFoes?: (team: string) => { playerId?: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[];
  deployDamageBot?: (playerId: string, dmg: number, fromPos: THREE.Vector3) => boolean;
}

interface BallFieldDeps {
  deps: EntitiesDeps;
  balls: Ball[];
  targets: Targetable[];
  classicMode: boolean;
  serverBalls: () => boolean;
  netTargetPosFor: (b: Ball) => THREE.Vector3;
  aggroFor: Kit['aggroFor'];
  kickDust: Kit['kickDust'];
  removeTarget: Kit['removeTarget'];
  atCap: Kit['atCap'];
  pickVariant: () => 0 | 1 | 2 | 3;
}
type Kit = ReturnType<typeof createSpeciesKit>;

// Owns the local (non-server) ball population: ambient spawns, elite
// splits, demo keyframe + snapshot recording. Server-owned ball
// replication lives in game/netBalls.ts — this field only runs the
// offline/demo side and culls locals once a server roster arrives.
function createBallField(f: BallFieldDeps) {
  const { deps, balls, targets } = f;
  const { scene, camera } = deps;
  let ballTimer = 0;
  let ballSnapshotTimer = 0;

// Wire bounce/peak keyframe callbacks so demo clips replay this ball accurately
function recordBallKeyframes(ball: Ball): void {
  const dm = deps.lazyDemoManager();
  if (!dm?.isRecording) return;
  ball.onBounce = (pos, vel) => {
    dm.recordTargetBounce(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);
  };
  ball.onPeak = (pos, vel) => {
    dm.recordTargetPeak(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);
  };
}

// ---- Balls ----
function spawnBall(): void {
  const dm = deps.lazyDemoManager();
  if (dm?.isPlaying) return; // skip normal spawning during demo playback
  if (f.serverBalls()) return; // connected: the server owns ball spawning
  if (f.atCap(balls, BALL_MAX)) return;
  // Classic mode is plain bouncy balls — no elites, no variants
  spawnBallOfVariant(f.classicMode ? 0 : f.pickVariant());
}

// Shared spawn path — director events need to spawn specific variants
function spawnBallOfVariant(variant: 0 | 1 | 2 | 3): Ball {
  const dm = deps.lazyDemoManager();
  const ball = new Ball(scene, deps.lazyTerrain(), variant);
  balls.push(ball);
  targets.push(ball);
  if (ball.variant === 3) ball.onDeath = (t) => spawnSplitChildren(t);
  if (dm?.isRecording) {
    dm.recordTargetSpawned(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant);
    recordBallKeyframes(ball);
  }
  return ball;
}

// Director-friendly spawn — an elite on demand (skips the cap: events
// are authored moments, the population cap is for ambient trickle)
function spawnEliteBall(): void {
  if (deps.lazyDemoManager()?.isPlaying) return;
  if (f.serverBalls()) return;
  spawnBallOfVariant(3);
}

// Elite death: two variant-0 balls burst out of the corpse with divergent
// velocities. Kill-it-close = you're suddenly fighting two balls point-blank;
// kill-it-far = free loot. The decision IS the mechanic.
function spawnSplitChildren(t: Targetable): void {
  if (deps.lazyDemoManager()?.isPlaying) return;
  if (f.serverBalls()) return;
  const dm = deps.lazyDemoManager();
  for (let k = 0; k < 2; k++) {
    const child = new Ball(scene, deps.lazyTerrain(), 0);
    const a = Math.random() * Math.PI * 2;
    child.pos.copy(t.pos);
    child.vel.set(Math.cos(a) * 14, 9 + Math.random() * 6, Math.sin(a) * 14);
    balls.push(child);
    targets.push(child);
    if (dm?.isRecording) {
      dm.recordTargetSpawned(child.id, { x: child.pos.x, y: child.pos.y, z: child.pos.z }, { x: child.vel.x, y: child.vel.y, z: child.vel.z }, child.variant);
      recordBallKeyframes(child);
    }
  }
}

function updateBalls(dt: number): void {
  const dm = deps.lazyDemoManager();
  if (dm?.isPlaying) {
    deps.updateBallsPlayback(dt);
    return;
  }

  const netMode = f.serverBalls();
  ballTimer += dt;
  if (!netMode && ballTimer >= BALL_SPAWN_INTERVAL) {
    ballTimer = 0;
    spawnBall();
  }

  Ball.viewPos.copy(camera.position); // feeds billboarded ball ribbon trails
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i]!;
    if (netMode && !b.netDriven && !b.dead) b.netKill(); // cull pre-connect locals
    b.update(dt, deps.lazyTerrain(), b.netDriven ? f.netTargetPosFor(b) : f.aggroFor(b, b.pos, dt, PROFILES.fodder));
    f.kickDust(b, dt); // bounce frames puff — airborne frames don't
    // Only remove ball when trails have fully faded out
    if (b.disposed) f.removeTarget(balls, i, b);
  }

  recordBallSnapshots(dt);
}

// Periodic ball position snapshot for demo recording (every 0.5s)
// This ensures clip snapshots for pre-existing balls are never stale
function recordBallSnapshots(dt: number): void {
  const dm = deps.lazyDemoManager();
  if (!dm?.isRecording) return;
  ballSnapshotTimer += dt;
  if (ballSnapshotTimer < 0.5) return;
  ballSnapshotTimer = 0;
  for (const b of balls) {
    if (!b.dead) {
      dm.recordTargetPeak(b.id, { x: b.pos.x, y: b.pos.y, z: b.pos.z }, { x: b.vel.x, y: b.vel.y, z: b.vel.z }, b.variant);
    }
  }
}

  return { spawnBall, spawnEliteBall, updateBalls, recordBallKeyframes, spawnBallOfVariant };
}
// Owns every ambient-entity registry (balls/crawlers/turretters/rollers/
// nuggets) plus their spawn timers, update passes, and demo keyframe
// recording. `targets` is the shared projectile/blast surface — every
// hittable entity lands in it. Per-family species blocks live in
// game/species/*.ts; this file keeps balls/nuggets (they're networked
// and demo-recorded) and orchestrates the rest.
export function createEntities(deps: EntitiesDeps) {
  const { scene, logger } = deps;

  const balls: Ball[] = [];
  const targets: Targetable[] = [];
  const nuggets: Nugget[] = [];
  const _noVel = new THREE.Vector3(); // dropNugget scratch — at-rest tosses
  let nuggetsCollected = 0;

  // ?mode=classic — plain bounce-and-shoot: variant-0 balls only
  const CLASSIC_MODE = urlParams.isClassic;

  // Shared species machinery (threat tables, damage funnel, spawn ring,
  // LOD ticking, dust/bolt emitters) lives in game/speciesKit.ts.
  // Assigned right after the kit — brains reference it lazily, so the
  // constructor order (kit → deployables) doesn't matter to call sites.
  const kit = createSpeciesKit(deps, targets, () => deployables);
  const deployables = new Deployables({
    ...deps,
    targets,
    lazyCombat: () => deps.lazyCombat?.(),
    enemyBots: deps.deployEnemyBots,
    botFoes: deps.deployBotFoes,
    damageBot: deps.deployDamageBot,
    // Nugget pack offline: the pod lands and mints a local gem (connected
    // play uses the server's pickupSpawn edge instead).
    dropNugget: (pos) => spawnNuggetsAt(pos, 1, _noVel),
  });
  const {
    removeTarget, aggroFor, reportTargetDamage, kickDust, atCap,
  } = kit;

  // Species families — registries + spawn + update wiring live in
  // game/species/*. Each gets the same ctx (deps, kit funnels, targets).
  const melee = createMeleeSpecies({ deps, kit, targets });
  const flyers = createFlyerSpecies({ deps, kit, targets });
  const siege = createSiegeSpecies({ deps, kit, targets });
  const ambient = createAmbientSpecies({ deps, kit, targets });

  const { crawlers, scarabs, grubs, snakes, rollers } = melee;
  const { gnats, seekers, rakks, strifers } = flyers;
  const { turrets, overlords, mines, banelings, totems } = siege;
  const { weeds } = ambient;

  // Server-owned ball lifecycle (ballSpawn/ballSegment/ballDie handlers +
  // the stamped-sim-time clock) lives in game/netBalls.ts.
  const netBalls = createNetBalls(deps, { balls, targets, nuggets }, logger);
  const { serverBalls, netBallSpawn, netBallSegment, netBallDie, netBallRoster, netTargetPosFor } = netBalls;
  const netCrawlers = createNetCrawlers(deps, { crawlers, scarabs, rakks, rollers, gnats, snakes, banelings, totems, targets });
  const { netCrawlSpawn, netCrawlEvt, netCrawlDie, netCrawlRoster } = netCrawlers;

  const ballField = createBallField({
    deps, balls, targets, classicMode: CLASSIC_MODE,
    serverBalls, netTargetPosFor, aggroFor, kickDust, removeTarget, atCap, pickVariant,
  });
  const { spawnBall, spawnEliteBall, updateBalls, recordBallKeyframes } = ballField;

  // ---- Nuggets (pickup gems dropped by destroyed targets) ----
  function updateNuggets(dt: number): void {
    const terrain = deps.lazyTerrain();
    const player = deps.lazyPlayer();
    // In team mode nuggets sweep toward the nearest living collector —
    // bots mine gems too, that's the whole game mode.
    const collectors = deps.nuggetCollectors?.();
    for (let i = nuggets.length - 1; i >= 0; i--) {
      const n = nuggets[i]!;
      let magnetPos = player.pos;
      let magnetId = 'local';
      let magnetScale = player.mods.pickupRadius;
      if (collectors) {
        let bestD = Infinity;
        for (const c of collectors) {
          if (!c.alive) continue;
          const d = c.pos.distanceToSquared(n.pos);
          if (d < bestD) { bestD = d; magnetPos = c.pos; magnetId = c.id; magnetScale = c.pickupScale ?? 1; }
        }
      }
      n.update(dt, terrain, magnetPos, magnetScale);
      if (n.collected && !n.collectNotified) {
        n.collectNotified = true;
        if (magnetId === 'local') {
          nuggetsCollected++;
          player.grantJetBoost();
          player.heal(0.2); // 20% max hp per nugget
          deps.lazyNetworkManager()?.sendHeal(20); // server stays the truth — clamped 25/call
          sfx.powerup('gem'); // same crystal chime server-owned gems play on collect
          logger.info(`Nugget collected (${nuggetsCollected} total)`);
        }
        deps.onNuggetCollect?.(magnetId);
        deps.lazyEffects().spawnImpact(n.pos, n.vel);
      }
      if (n.dead) {
        n.dispose();
        nuggets.splice(i, 1);
      }
    }
  }

  /** Loose gems from non-target deaths (bots fragged offline — combat's
   *  onTargetDestroyed already covers Targetable deaths). */
  function spawnNuggetsAt(pos: THREE.Vector3, count: number, inheritVel: THREE.Vector3): void {
    for (let i = 0; i < count; i++) nuggets.push(new Nugget(scene, pos, inheritVel));
  }

  return {
    balls, crawlers, scarabs, grubs, snakes, gnats, turrets, rollers, seekers, overlords, mines, totems, rakks, weeds, strifers, targets, nuggets, banelings,
    spawnNuggetsAt,
    getNuggetsCollected: () => nuggetsCollected,
    spawnBall,
    spawnCrawler: melee.spawnCrawler, spawnScarab: melee.spawnScarab, spawnGrub: melee.spawnGrub, spawnSnake: melee.spawnSnake,
    spawnGnatCloud: flyers.spawnGnatCloud, spawnSeeker: flyers.spawnSeeker, spawnRakk: flyers.spawnRakk,
    spawnRoller: melee.spawnRoller,
    spawnTurretter: siege.spawnTurretter, spawnOverlord: siege.spawnOverlord,
    spawnTotem: siege.spawnTotem, spawnUberTotem: siege.spawnUberTotem,
    spawnEliteBall, plantMine: siege.plantMine,
    turretBolts: siege.turretBolts, consumeBolt: siege.consumeBolt, cookBoltsNear: siege.cookBoltsNear,
    shieldObstacles: () => deployables.shieldObstacles(),
    reportTargetDamage,
    deployables,
    updateDeployables: (dt: number) => deployables.update(dt),
    netBallSpawn, netBallSegment, netBallDie, netBallRoster,
    netCrawlSpawn, netCrawlEvt, netCrawlDie, netCrawlRoster,
    updateBalls,
    updateCrawlers: melee.updateCrawlers, updateScarabs: melee.updateScarabs,
    updateGrubs: melee.updateGrubs, updateSnakes: melee.updateSnakes,
    updateGnats: flyers.updateGnats, updateSeekers: flyers.updateSeekers, updateRakks: flyers.updateRakks, updateStrifers: flyers.updateStrifers,
    updateRollers: melee.updateRollers,
    updateTurrets: siege.updateTurrets, updateOverlords: siege.updateOverlords, updateTotems: siege.updateTotems,
    updateWeeds: ambient.updateWeeds,
    // All per-species ticks in one iterable — gameLoop iterates, so adding
    // a species never touches the loop. Deployables stay separate (they
    // aren't a species — no spawn cadence, no targets registry).
    updateSpeciesAll: (dt: number) => {
      melee.updateCrawlers(dt); melee.updateScarabs(dt); melee.updateGrubs(dt);
      melee.updateSnakes(dt); melee.updateRollers(dt);
      flyers.updateGnats(dt); flyers.updateSeekers(dt); flyers.updateRakks(dt); flyers.updateStrifers(dt);
      siege.updateTurrets(dt); siege.updateOverlords(dt); siege.updateTotems(dt);
      ambient.updateWeeds(dt);
    },
    updateNuggets,
    recordBallKeyframes,
  };
}
