import * as THREE from 'three';



import { BALL_MAX } from '../core/config.js';

import { urlParams } from '../core/params.js';

import * as sfx from '../core/sfx.js';

import { createNetBalls } from './netBalls.js';

import { createNetCrawlers } from './netCrawlers.js';

import { createSpeciesKit } from './speciesKit.js';

import { PROFILES } from './targeting.js';

import { Ball, pickVariant, type Targetable } from '../entities/balls.js';
import { flushDebugPins } from '../effects/debugPins.js';

import { targetDemoId } from '../demo/types.js';

import { Nugget } from '../entities/Nugget.js';
import { PICKUP_ACCENT, pickupParts } from '../entities/PickupModel.js';
import { tokenTier, type PickupKind } from '../../../shared/pickups.js';

import { BELT_MAX } from '../../../shared/weapons.js';

import type { GameContext } from './context.js';

import { Deployables } from './deployables.js';

import { createMeleeSpecies } from './species/melee.js';

import { createFlyerSpecies } from './species/flyers.js';

import { createSiegeSpecies } from './species/siege.js';

import { createAmbientSpecies } from './species/ambient.js';
import { spawnRand, drawSplitVel } from '../../../shared/spawnDice.js';



export interface EntitiesDeps extends GameContext {

  // scene/camera exist before entities is constructed - eager refs, no lazy needed

  scene: THREE.Scene;

  camera: THREE.Camera;

  // Playback balls are owned by demoLifecycle - updateBalls defers to it

  updateBallsPlayback: (dt: number) => void;

  /** Nugget Wars: extra collectors (bots) nuggets magnet toward, plus a

   *  callback so each pickup banks on the right team. Absent = solo mode,

   *  the player is the only collector. */

  nuggetCollectors?: () => { id: string; pos: THREE.Vector3; alive: boolean; pickupScale?: number }[];

  onNuggetCollect?: (collectorId: string, kind?: PickupKind, val?: number) => void;

  /** Deployables: combat resolves after entities is built - lazy getter. */

  lazyCombat?: () => { hitTargetLocal(t: Targetable, dmg: number, attackerId?: string): boolean; predictLocalShove?(pos: THREE.Vector3, radius: number, force: number, mode: 'push' | 'pull', shooterId?: string, meta?: { pid?: string; wt?: number; pop?: string }): boolean } | undefined;

  /** Enemy bots deployable turrets may shoot (deployer's team excluded). */

  deployEnemyBots?: () => { playerId: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean }[];

  /** Hostiles of a given team - a bot-owned turret/mine scans these. */

  deployBotFoes?: (team: string) => import('./bots/botSenses.js').BotEntry[];

  deployDamageBot?: (playerId: string, dmg: number, fromPos: THREE.Vector3) => boolean;

  /** Offline base-grid edge - a downed generator drops its team's panes. */

  deployBasePower?: (team: string, on: boolean) => void;

  /** Deployable-hit damage numbers (solo base raids need the feedback). */

  deployDamageNumbers?: () => { spawn(pos: THREE.Vector3, amount: number, color: string, cam: THREE.Camera): void };

  /** Live vitals bar over a damaged deployable/base asset. */

  deployItemBar?: (item: { pos: THREE.Vector3; dead: boolean; v: { health: number; armor: number; maxHealth: number } }, ally: boolean) => void;

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

// replication lives in game/netBalls.ts - this field only runs the

// offline/demo side and culls locals once a server roster arrives.

function createBallField(f: BallFieldDeps) {

  const { deps, balls, targets } = f;

  const { scene, camera } = deps;

  let ballTimer = 0;

  // OG RadialSpawner cadence: random 0-10s trickle, instant refill on wipeout

  let nextBallSpawn = spawnRand() * 10;

  let ballSnapshotTimer = 0;



// Wire bounce/peak keyframe callbacks so demo clips replay this ball accurately

function recordBallKeyframes(ball: Ball): void {

  const dm = deps.lazyDemoManager();

  if (!dm?.isRecording) {return;}

  ball.onBounce = (pos, vel): void => {

    dm.recordTargetBounce(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);

  };

  ball.onPeak = (pos, vel): void => {

    dm.recordTargetPeak(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);

  };

}



// ---- Balls ----

function spawnBall(): void {

  const dm = deps.lazyDemoManager();

  if (dm?.isPlaying) {return;} // skip normal spawning during demo playback

  if (f.serverBalls()) {return;} // connected: the server owns ball spawning

  if (urlParams.noBallsLocal) {return;} // explicit ?noballs only - the fps-noballs room-creation flag must not starve the local field

  if (f.atCap(balls, BALL_MAX)) {return;}

  // Classic mode is plain bouncy balls - no elites, no variants

  spawnBallOfVariant(f.classicMode ? 0 : f.pickVariant());

}



// Shared spawn path - director events need to spawn specific variants

function spawnBallOfVariant(variant: 0 | 1 | 2 | 3): Ball {

  const dm = deps.lazyDemoManager();

  const ball = new Ball(scene, deps.lazyTerrain(), variant, undefined, deps.lazyPlayer().pos);

  balls.push(ball);

  targets.push(ball);

  if (ball.variant === 3) {ball.onDeath = (t): void => spawnSplitChildren(t);}

  if (dm?.isRecording) {

    dm.recordTargetSpawned(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant);

    recordBallKeyframes(ball);

  }

  return ball;

}



// Director-friendly spawn - an elite on demand (skips the cap: events

// are authored moments, the population cap is for ambient trickle)

function spawnEliteBall(): void {

  if (deps.lazyDemoManager()?.isPlaying) {return;}

  if (f.serverBalls()) {return;}

  if (urlParams.noBallsLocal) {return;}

  spawnBallOfVariant(3);

}



// Elite death: two variant-0 balls burst out of the corpse with divergent

// velocities. Kill-it-close = you're suddenly fighting two balls point-blank;

// kill-it-far = free loot. The decision IS the mechanic.

function spawnSplitChildren(t: Targetable): void {

  if (deps.lazyDemoManager()?.isPlaying) {return;}

  if (f.serverBalls()) {return;}

  if (urlParams.noBallsLocal) {return;}

  const dm = deps.lazyDemoManager();

  for (let k = 0; k < 2; k += 1) {

    const child = new Ball(scene, deps.lazyTerrain(), 0);

    child.pos.copy(t.pos);

    const sv = drawSplitVel(spawnRand);

    child.vel.set(sv.x, sv.y, sv.z);

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

  // Billboard anchor + retired-ribbon fade tick in BOTH lanes - during
  // playback the early return below skipped them, so ribbons parked by
  // die/teleport froze in the sky forever instead of decaying out.
  Ball.viewPos.copy(camera.position); // feeds billboarded ball ribbon trails
  Ball.updateDyingRibbons(dt); // retired teleport tails fade out where they were
  flushDebugPins(scene, camera.position); // F1 ball-position pin rebuild (no-op when off)

  if (dm?.isPlaying) {

    deps.updateBallsPlayback(dt);

    return;

  }



  const netMode = f.serverBalls();

  ballTimer += dt;

  if (!netMode && (balls.length === 0 || ballTimer >= nextBallSpawn)) {

    ballTimer = 0;

    nextBallSpawn = spawnRand() * 10;

    spawnBall();

  }



  // viewPos + dyingRibbons already ticked above the playback early-return.

  // ?debug: per-slice ball cost - the phase dump blamed balls at 15ms
  // but every piece reads cheap; this names the hog without a profiler.
  const prof = urlParams.debug ? { aggro: 0, upd: 0, dust: 0, snap0: performance.now(), snap: 0, n: 0 } : null;

  for (let i = balls.length - 1; i >= 0; i -= 1) {

    const b = balls[i]!;

    if (netMode && !b.netDriven && !b.dead) {b.netKill();} // cull pre-connect locals

    // Classic: docile balls leash straight to the player - aggroFor would

    // degrade to a wander waypoint near the BALL once its fodder leash drops

    // the target, and the >200m drift check would never fire again.

    let ballTarget;

    const t0 = prof ? performance.now() : 0;

    if (b.netDriven) {ballTarget = f.netTargetPosFor(b);}

    else if (f.classicMode) {ballTarget = deps.lazyPlayer().pos;}

    else {ballTarget = f.aggroFor(b, b.pos, dt, PROFILES.fodder);}

    const t1 = prof ? performance.now() : 0;
    b.update(dt, deps.lazyTerrain(), ballTarget);
    const t2 = prof ? performance.now() : 0;

    f.kickDust(b, dt); // bounce frames puff - airborne frames don't
    if (prof) {prof.aggro += t1 - t0; prof.upd += t2 - t1; prof.dust += performance.now() - t2; prof.n++;}

    // Only remove ball when trails have fully faded out

    if (b.disposed) {f.removeTarget(balls, i, b);}

  }



  recordBallSnapshots(dt);
  if (prof) {prof.snap = performance.now() - prof.snap0;
    if (prof.upd + prof.aggro > 0.5) {deps.logger.info('ballprof', { n: prof.n, aggro: Number(prof.aggro.toFixed(2)), upd: Number(prof.upd.toFixed(2)), dust: Number(prof.dust.toFixed(2)), snap: Number(prof.snap.toFixed(2)) });}}

}



// Periodic ball position snapshot for demo recording (every 0.5s)

// This ensures clip snapshots for pre-existing balls are never stale

function recordBallSnapshots(dt: number): void {

  const dm = deps.lazyDemoManager();

  if (!dm?.isRecording) {return;}

  ballSnapshotTimer += dt;

  if (ballSnapshotTimer < 0.5) {return;}

  ballSnapshotTimer = 0;

  for (const b of balls) {

    if (!b.dead) {

      dm.recordTargetPeak(targetDemoId(b), { x: b.pos.x, y: b.pos.y, z: b.pos.z }, { x: b.vel.x, y: b.vel.y, z: b.vel.z }, b.variant);

    }

  }

}



  return { spawnBall, spawnEliteBall, updateBalls, recordBallKeyframes, spawnBallOfVariant };

}

// Owns every ambient-entity registry (balls/crawlers/turretters/rollers/

// nuggets) plus their spawn timers, update passes, and demo keyframe

// recording. `targets` is the shared projectile/blast surface - every

// hittable entity lands in it. Per-family species blocks live in

// game/species/*.ts; this file keeps balls/nuggets (they're networked

// and demo-recorded) and orchestrates the rest.

const noSpawn = <A extends unknown[]>(off: boolean, fn: (...a: A) => void): ((...a: A) => void) =>
  off ? (): void => { return; } : fn;

export function createEntities(deps: EntitiesDeps) {

  const { scene, logger } = deps;



  const balls: Ball[] = [];

  const targets: Targetable[] = [];

  const nuggets: Nugget[] = [];

  function spawnNuggetsAt(pos: THREE.Vector3, count: number, inheritVel: THREE.Vector3, kind: PickupKind = 'gem', val = 1): void {

    for (let i = 0; i < count; i += 1) {
      const tier = kind === 'token' ? tokenTier(val) : null;
      const n = new Nugget(scene, pos, inheritVel.clone().multiplyScalar(0.5),
        tier?.color ?? PICKUP_ACCENT[kind], pickupParts(kind), tier?.scale ?? 1);
      n.kind = kind; n.val = val;
      nuggets.push(n);
    }

  // Assigned right after the kit - brains reference it lazily, so the

  }

  const _noVel = new THREE.Vector3(); // dropNugget scratch - at-rest tosses

  let nuggetsCollected = 0;



  // ?mode=classic - plain bounce-and-shoot: variant-0 balls only

  const CLASSIC_MODE = urlParams.isClassic;



  // Shared species machinery (threat tables, damage funnel, spawn ring,

  // LOD ticking, dust/bolt emitters) lives in game/speciesKit.ts.

  // constructor order (kit → deployables) doesn't matter to call sites.

  const kit = createSpeciesKit(deps, targets, (): Deployables => deployables);

  const deployables = new Deployables((((Object.assign({}, deps, {targets,lazyCombat: () => deps.lazyCombat?.(),enemyBots: deps.deployEnemyBots,botFoes: deps.deployBotFoes,damageBot: deps.deployDamageBot,basePower: deps.deployBasePower,damageNumbers: deps.deployDamageNumbers?.(),showItemBar: deps.deployItemBar,dropNugget: (pos: THREE.Vector3): void => spawnNuggetsAt(pos, 1, _noVel)})))));

  const {

    removeTarget, aggroFor, reportTargetDamage, kickDust, atCap,

  } = kit;



  // Species families - registries + spawn + update wiring live in

  // game/species/*. Each gets the same ctx (deps, kit funnels, targets).

  const melee = createMeleeSpecies({ deps, kit, targets });

  const flyers = createFlyerSpecies({ deps, kit, targets });

  const siege = createSiegeSpecies({ deps, kit, targets });

  const ambient = createAmbientSpecies({ deps, kit, targets });



  const { crawlers, scarabs, grubs, snakes, rollers } = melee;

  const { gnats, seekers, rakks, strifers, buzzards } = flyers;

  const { turrets, overlords, mines, banelings, totems } = siege;

  const { weeds } = ambient;



  // Server-owned ball lifecycle (ballSpawn/ballSegment/ballDie handlers +

  // the stamped-sim-time clock) lives in game/netBalls.ts.

  const netBalls = createNetBalls(deps, { balls, targets, nuggets }, logger);

  const { serverBalls, netBallSpawn, netBallSegment, netBallDie, netBallRoster, netTargetPosFor } = netBalls;

  const netCrawlers = createNetCrawlers(deps, { crawlers, scarabs, rakks, rollers, gnats, snakes, banelings, totems, buzzards, targets });

  const { netCrawlSpawn, netCrawlEvt, netCrawlDie, netCrawlRoster } = netCrawlers;



  const ballField = createBallField({

    deps, balls, targets, classicMode: CLASSIC_MODE,

    serverBalls, netTargetPosFor, aggroFor, kickDust, removeTarget, atCap, pickVariant,

  });

  const { spawnBall, spawnEliteBall, updateBalls, recordBallKeyframes } = ballField;



  // ?nocreatures/?noballs - the lobby sim-gates mint server rooms bare via

  // the join handshake; offline there is no mint, so the local population

  // honors the same params at the spawn boundary instead. Ambient species

  // timers are gated in speciesKit.updateSpecies; these cover everything

  // else that calls the spawn API (director picks/beats, boot seeds).

  // Wire-owned spawns (netBalls/netCrawlers) never route through here.

  // Creatures are opt-IN now: species sim was ~1ms/creature/frame in the
  // last perf dump, so the default local population is balls-only;
  // ?creatures / fps-creatures brings the zoo back, nocreatures still
  // force-off.
  const gateC = <A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void => noSpawn(urlParams.noCreatures || !urlParams.creatures, fn);



  // ---- Nuggets (pickup gems dropped by destroyed targets) ----

  function updateNuggets(dt: number): void {

    const terrain = deps.lazyTerrain();

    const player = deps.lazyPlayer();

    // In team mode nuggets sweep toward the nearest living collector -

    // bots mine gems too, that's the whole game mode.

    const collectors = deps.nuggetCollectors?.();

    for (let i = nuggets.length - 1; i >= 0; i -= 1) {

      const n = nuggets[i]!;

      let magnetPos = player.pos;

      let magnetId = 'local';

      let magnetScale = player.mods.pickupRadius;

      if (collectors) {

        let bestD = Infinity;

        for (const c of collectors) {

          if (!c.alive) {continue;}

          const d = c.pos.distanceToSquared(n.pos);

          if (d < bestD) { bestD = d; magnetPos = c.pos; magnetId = c.id; magnetScale = c.pickupScale ?? 1; }

        }

      }

      n.update(dt, terrain, magnetPos, magnetScale);

      if (n.collected && !n.collectNotified) {

        n.collectNotified = true;

        if (magnetId === 'local') {

nuggetsCollected += 1;

          player.grantJetBoost();

          player.heal(0.2); // 20% max hp per nugget

          // Belt income - the wired collect (net/pickups.ts) pays a charge

          // per gem; offline nuggets must or the pack economy only exists

          // online.

          player.beltCharges = Math.min(BELT_MAX, player.beltCharges + 1);

          deps.lazyNetworkManager()?.sendHeal(20); // server stays the truth - clamped 25/call

          sfx.powerup('gem'); // same crystal chime server-owned gems play on collect

          logger.info(`Nugget collected (${nuggetsCollected} total)`);

        }

        deps.onNuggetCollect?.(magnetId, n.kind, n.val);

        deps.lazyEffects().spawnImpact(n.pos, n.vel);

      }

      if (n.dead) {

        n.dispose();

        nuggets.splice(i, 1);

      }

    }

  }



  /** Loose gems from non-target deaths (bots fragged offline - combat's

   *  onTargetDestroyed already covers Targetable deaths). */



  return {

    balls, crawlers, scarabs, grubs, snakes, gnats, turrets, rollers, seekers, overlords, mines, totems, rakks, weeds, strifers, buzzards, targets, nuggets, banelings,

    spawnNuggetsAt,

    getNuggetsCollected: (): number => nuggetsCollected,

    spawnBall: noSpawn(urlParams.noBallsLocal, spawnBall),

    spawnCrawler: gateC(melee.spawnCrawler), spawnScarab: gateC(melee.spawnScarab), spawnGrub: gateC(melee.spawnGrub), spawnSnake: gateC(melee.spawnSnake),

    spawnGnatCloud: gateC(flyers.spawnGnatCloud), spawnSeeker: gateC(flyers.spawnSeeker), spawnRakk: gateC(flyers.spawnRakk),

    spawnRoller: gateC(melee.spawnRoller),

    spawnTurretter: gateC(siege.spawnTurretter), spawnOverlord: gateC(siege.spawnOverlord),

    spawnTotem: gateC(siege.spawnTotem), spawnUberTotem: gateC(siege.spawnUberTotem),

    spawnEliteBall: noSpawn(urlParams.noBallsLocal, spawnEliteBall), plantMine: gateC(siege.plantMine),

    turretBolts: siege.turretBolts, consumeBolt: siege.consumeBolt, cookBoltsNear: siege.cookBoltsNear,

    shieldObstacles: () => deployables.shieldObstacles(),

    reportTargetDamage,

    deployables,

    updateDeployables: (dt: number): void => deployables.update(dt),

    netBallSpawn, netBallSegment, netBallDie, netBallRoster,

    netCrawlSpawn, netCrawlEvt, netCrawlDie, netCrawlRoster,

    updateBalls,

    updateCrawlers: melee.updateCrawlers, updateScarabs: melee.updateScarabs,

    updateGrubs: melee.updateGrubs, updateSnakes: melee.updateSnakes,

    updateGnats: flyers.updateGnats, updateSeekers: flyers.updateSeekers, updateRakks: flyers.updateRakks, updateStrifers: flyers.updateStrifers, updateBuzzards: flyers.updateBuzzards,

    updateRollers: melee.updateRollers,

    updateTurrets: siege.updateTurrets, updateOverlords: siege.updateOverlords, updateTotems: siege.updateTotems,

    updateWeeds: ambient.updateWeeds,

    // All per-species ticks in one iterable - gameLoop iterates, so adding

    // a species never touches the loop. Deployables stay separate (they

    // aren't a species - no spawn cadence, no targets registry).

    updateSpeciesAll: (dt: number): void => {

      melee.updateCrawlers(dt); melee.updateScarabs(dt); melee.updateGrubs(dt);

      melee.updateSnakes(dt); melee.updateRollers(dt);

      flyers.updateGnats(dt); flyers.updateSeekers(dt); flyers.updateRakks(dt); flyers.updateStrifers(dt); flyers.updateBuzzards(dt);

      siege.updateTurrets(dt); siege.updateOverlords(dt); siege.updateTotems(dt);

      ambient.updateWeeds(dt);

    },

    updateNuggets,

    recordBallKeyframes,

  };

}

