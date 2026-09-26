import * as THREE from 'three';

import {
  BALL_SPAWN_INTERVAL, BALL_MAX,
  CRAWLER_MAX, CRAWLER_SPAWN_INTERVAL, CRAWLER_SPAWN_MIN, CRAWLER_SPAWN_MAX, CRAWLER_POUNCE_DAMAGE,
  TURRET_MAX, TURRET_SPAWN_INTERVAL, TURRET_SPAWN_MIN, TURRET_SPAWN_MAX, TURRET_BOLT_DAMAGE,
  ROLLER_MAX, ROLLER_SPAWN_INTERVAL, ROLLER_SPAWN_MIN, ROLLER_SPAWN_MAX,
  ROLLER_HIT_DAMAGE, ROLLER_HIT_FORCE,
} from '../core/config.js';
import type { ChildLogger } from '../core/Logger.js';
import type { DemoManager } from '../demo/index.js';
import { Ball, pickVariant, type Targetable } from '../entities/balls.js';
import { Crawler } from '../entities/Crawler.js';
import { Nugget } from '../entities/Nugget.js';
import type { Player } from '../entities/Player.js';
import { Roller } from '../entities/Roller.js';
import { Turretter } from '../entities/Turretter.js';
import type { EffectsManager } from '../effects/effects.js';
import { Explosion } from '../effects/explosion.js';
import { screenShake } from '../effects/screenShake.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { HUD } from '../ui/hud.js';
import type { Terrain } from '../world/terrain.js';
import type { WorldState } from './worldState.js';

export interface EntitiesDeps {
  scene: THREE.Scene;
  terrain: () => Terrain;
  camera: THREE.Camera;
  player: () => Player;
  effects: () => EffectsManager;
  hud: () => HUD;
  networkManager: () => NetworkManager;
  world: WorldState; // combat and entities share world.explosions
  demoManager: () => DemoManager | null;
  logger: ChildLogger;
  // Playback balls are owned by demoLifecycle — updateBalls defers to it
  updateBallsPlayback: (dt: number) => void;
}

// Owns every ambient-entity registry (balls/crawlers/turretters/rollers/
// nuggets) plus their spawn timers, update passes, and demo keyframe
// recording. `targets` is the shared projectile/blast surface — every
// hittable entity lands in it.
export function createEntities(deps: EntitiesDeps) {
  const { scene, camera, logger } = deps;

  const balls: Ball[] = [];
  const crawlers: Crawler[] = [];
  const turrets: Turretter[] = [];
  const rollers: Roller[] = [];
  const targets: Targetable[] = [];
  const nuggets: Nugget[] = [];
  let nuggetsCollected = 0;

  let ballTimer = 0;
  let ballSnapshotTimer = 0;
  let crawlerTimer = 0;
  let turretTimer = 0;
  let rollerTimer = 0;

  // Remove a dead/disposed entity from its registry AND the shared targets
  // surface — the targets array is what projectiles and blasts iterate.
  function removeTarget<T extends Targetable>(list: T[], i: number, e: T): void {
    list.splice(i, 1);
    const ti = targets.indexOf(e);
    if (ti >= 0) targets.splice(ti, 1);
  }

  // ---- Nuggets (pickup gems dropped by destroyed targets) ----
  function updateNuggets(dt: number): void {
    const terrain = deps.terrain();
    for (let i = nuggets.length - 1; i >= 0; i--) {
      const n = nuggets[i]!;
      n.update(dt, terrain, deps.player().pos);
      if (n.collected && !n.collectNotified) {
        n.collectNotified = true;
        nuggetsCollected++;
        deps.effects().spawnImpact(n.pos, n.vel);
        logger.info(`Nugget collected (${nuggetsCollected} total)`);
      }
      if (n.dead) {
        n.dispose();
        nuggets.splice(i, 1);
      }
    }
  }

  // Wire bounce/peak keyframe callbacks so demo clips replay this ball accurately
  function recordBallKeyframes(ball: Ball): void {
    const dm = deps.demoManager();
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
    const dm = deps.demoManager();
    if (dm?.isPlaying) return; // skip normal spawning during demo playback
    if (balls.filter(b => !b.dead).length >= BALL_MAX) return;
    const ball = new Ball(scene, deps.terrain(), pickVariant());
    balls.push(ball);
    targets.push(ball);
    if (dm?.isRecording) {
      dm.recordTargetSpawned(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant);
      recordBallKeyframes(ball);
    }
  }

  function updateBalls(dt: number): void {
    const dm = deps.demoManager();
    if (dm?.isPlaying) {
      deps.updateBallsPlayback(dt);
      return;
    }

    ballTimer += dt;
    if (ballTimer >= BALL_SPAWN_INTERVAL) {
      ballTimer = 0;
      spawnBall();
    }

    Ball.viewPos.copy(camera.position); // feeds billboarded ball ribbon trails
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i]!;
      b.update(dt, deps.terrain(), deps.player().pos);
      // Only remove ball when trails have fully faded out
      if (b.disposed) removeTarget(balls, i, b);
    }

    recordBallSnapshots(dt);
  }

  // ---- Crawlers (terrain-hugging targets that pounce) ----
  function spawnCrawler(): void {
    if (deps.demoManager()?.isPlaying) return;
    if (crawlers.filter(c => !c.dead).length >= CRAWLER_MAX) return;
    const ang = Math.random() * Math.PI * 2;
    const dist = CRAWLER_SPAWN_MIN + Math.random() * (CRAWLER_SPAWN_MAX - CRAWLER_SPAWN_MIN);
    const player = deps.player();
    const c = new Crawler(scene, deps.terrain(), new THREE.Vector3(
      player.pos.x + Math.cos(ang) * dist, 0, player.pos.z + Math.sin(ang) * dist,
    ));
    c.onLanded = (pos) => deps.effects().spawnJumpDust(pos);
    c.onPounceHit = (cr) => {
      player.applyKnockback(cr.pos, 10);
      deps.networkManager()?.sendEnvironmentDamage(CRAWLER_POUNCE_DAMAGE);
      deps.hud().showHitMarker(); // reuse hit flash as "something hit you" feedback
    };
    crawlers.push(c);
    targets.push(c);
  }

  function updateCrawlers(dt: number): void {
    crawlerTimer += dt;
    if (crawlerTimer >= CRAWLER_SPAWN_INTERVAL) {
      crawlerTimer = 0;
      spawnCrawler();
    }
    for (let i = crawlers.length - 1; i >= 0; i--) {
      const c = crawlers[i]!;
      c.update(dt, deps.terrain(), deps.player().pos);
      if (c.dead) {
        c.dispose();
        removeTarget(crawlers, i, c);
      }
    }
  }

  // ---- Turretters (plant-and-shell enemies that lob themselves at you) ----
  function spawnTurretter(): void {
    if (deps.demoManager()?.isPlaying) return;
    if (turrets.filter(t => !t.dead).length >= TURRET_MAX) return;
    const ang = Math.random() * Math.PI * 2;
    const dist = TURRET_SPAWN_MIN + Math.random() * (TURRET_SPAWN_MAX - TURRET_SPAWN_MIN);
    const player = deps.player();
    const t = new Turretter(scene, deps.terrain(), new THREE.Vector3(
      player.pos.x + Math.cos(ang) * dist, 0, player.pos.z + Math.sin(ang) * dist,
    ));
    const fx = deps.effects();
    // Bolt pops: compact orange Explosion — reads as a turret shell, not
    // a rocket. Lands and player-hits share it.
    const boltPop = (pos: THREE.Vector3) => {
      deps.world.explosions.push(new Explosion(scene, pos, false, 0, deps.terrain(), 0.3, 0xffaa44));
      screenShake.blast(pos, 1.8, deps.player().pos); // small pop — subtle
    };
    t.onLanded = (pos) => {
      deps.world.explosions.push(new Explosion(scene, pos, false, 0, deps.terrain(), 0.4, 0xff8844));
      screenShake.blast(pos, 2.4, deps.player().pos);
    };
    t.onLaunch = (pos) => fx.spawnJumpDust(pos);
    t.onBoltLand = (pos) => boltPop(pos);
    t.onBoltHit = () => {
      boltPop(player.pos.clone());
      player.applyKnockback(t.pos, 6);
      deps.networkManager()?.sendEnvironmentDamage(TURRET_BOLT_DAMAGE);
      deps.hud().showHitMarker();
    };
    turrets.push(t);
    targets.push(t);
  }

  function updateTurrets(dt: number): void {
    turretTimer += dt;
    if (turretTimer >= TURRET_SPAWN_INTERVAL) {
      turretTimer = 0;
      spawnTurretter();
    }
    for (let i = turrets.length - 1; i >= 0; i--) {
      const t = turrets[i]!;
      t.update(dt, deps.terrain(), deps.player().pos, deps.player().vel);
      if (t.dead) {
        t.dispose();
        removeTarget(turrets, i, t);
      }
    }
  }

  // ---- Rollers (big homing boulders — the hitbox is the threat) ----
  function spawnRoller(): void {
    if (deps.demoManager()?.isPlaying) return;
    if (rollers.filter(r => !r.dead).length >= ROLLER_MAX) return;
    const ang = Math.random() * Math.PI * 2;
    const dist = ROLLER_SPAWN_MIN + Math.random() * (ROLLER_SPAWN_MAX - ROLLER_SPAWN_MIN);
    const player = deps.player();
    const r = new Roller(scene, deps.terrain(), new THREE.Vector3(
      player.pos.x + Math.cos(ang) * dist, 0, player.pos.z + Math.sin(ang) * dist,
    ));
    r.onLanded = (pos) => deps.effects().spawnJumpDust(pos);
    r.onHit = (rl) => {
      player.applyKnockback(rl.pos, ROLLER_HIT_FORCE);
      deps.networkManager()?.sendEnvironmentDamage(ROLLER_HIT_DAMAGE);
      deps.hud().showHitMarker();
    };
    rollers.push(r);
    targets.push(r);
  }

  function updateRollers(dt: number): void {
    rollerTimer += dt;
    if (rollerTimer >= ROLLER_SPAWN_INTERVAL) {
      rollerTimer = 0;
      spawnRoller();
    }
    for (let i = rollers.length - 1; i >= 0; i--) {
      const r = rollers[i]!;
      r.update(dt, deps.terrain(), deps.player().pos);
      if (r.dead) {
        r.dispose();
        removeTarget(rollers, i, r);
      }
    }
  }

  // Periodic ball position snapshot for demo recording (every 0.5s)
  // This ensures clip snapshots for pre-existing balls are never stale
  function recordBallSnapshots(dt: number): void {
    const dm = deps.demoManager();
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

  return {
    balls, crawlers, turrets, rollers, targets, nuggets,
    getNuggetsCollected: () => nuggetsCollected,
    spawnBall, spawnCrawler, spawnTurretter, spawnRoller,
    updateBalls, updateCrawlers, updateTurrets, updateRollers, updateNuggets,
    recordBallKeyframes,
  };
}
