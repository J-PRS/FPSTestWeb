import * as THREE from 'three';

import {
  BALL_SPAWN_INTERVAL, BALL_MAX,
  CRAWLER_MAX, CRAWLER_SPAWN_INTERVAL, CRAWLER_SPAWN_MIN, CRAWLER_SPAWN_MAX, CRAWLER_POUNCE_DAMAGE,
  TURRET_MAX, TURRET_SPAWN_INTERVAL, TURRET_SPAWN_MIN, TURRET_SPAWN_MAX, TURRET_BOLT_DAMAGE,
  ROLLER_MAX, ROLLER_SPAWN_INTERVAL, ROLLER_SPAWN_MIN, ROLLER_SPAWN_MAX,
  ROLLER_HIT_DAMAGE, ROLLER_HIT_FORCE,
  SEEKER_MAX, SEEKER_SPAWN_INTERVAL, SEEKER_SPAWN_MIN, SEEKER_SPAWN_MAX,
  SEEKER_STING_DAMAGE, SEEKER_STING_FORCE,
  MINER_MAX, MINER_SPAWN_INTERVAL, MINER_SPAWN_MIN, MINER_SPAWN_MAX,
  MINE_MAX, MINE_BLAST_RADIUS, MINE_DAMAGE_MAX, MINE_KNOCKBACK,
  TOTEM_MAX, TOTEM_SPAWN_INTERVAL, TOTEM_SPAWN_MIN, TOTEM_SPAWN_MAX,
  TOTEM_BOLT_DAMAGE,
  RAKK_MAX, RAKK_SPAWN_INTERVAL, RAKK_SPAWN_MIN, RAKK_SPAWN_MAX,
  RAKK_CLAW_DAMAGE, RAKK_CLAW_FORCE,
  ROCKET_RADIUS, // Explosion VFX scale reference — blast visuals normalize to it
} from '../core/config.js';
import type { ChildLogger } from '../core/Logger.js';
import type { DemoManager } from '../demo/index.js';
import { Ball, pickVariant, type Targetable } from '../entities/balls.js';
import { Crawler } from '../entities/Crawler.js';
import { Nugget } from '../entities/Nugget.js';
import type { Player } from '../entities/Player.js';
import { Miner } from '../entities/Miner.js';
import { Mine } from '../entities/Mine.js';
import { Rakk } from '../entities/Rakk.js';
import { Roller } from '../entities/Roller.js';
import { Seeker } from '../entities/Seeker.js';
import { Totem } from '../entities/Totem.js';
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
  const seekers: Seeker[] = [];
  const miners: Miner[] = [];
  const mines: Mine[] = [];
  const totems: Totem[] = [];
  const rakks: Rakk[] = [];
  const targets: Targetable[] = [];
  const nuggets: Nugget[] = [];
  let nuggetsCollected = 0;

  let ballTimer = 0;
  let ballSnapshotTimer = 0;

  // Remove a dead/disposed entity from its registry AND the shared targets
  // surface — the targets array is what projectiles and blasts iterate.
  function removeTarget<T extends Targetable>(list: T[], i: number, e: T): void {
    list.splice(i, 1);
    const ti = targets.indexOf(e);
    if (ti >= 0) targets.splice(ti, 1);
  }

  // Spawn position on a ring around the player — every ambient spawn uses it.
  function ringPos(min: number, max: number): THREE.Vector3 {
    const ang = Math.random() * Math.PI * 2;
    const dist = min + Math.random() * (max - min);
    const player = deps.player();
    return new THREE.Vector3(
      player.pos.x + Math.cos(ang) * dist, 0, player.pos.z + Math.sin(ang) * dist,
    );
  }

  // Enemy-contact damage funnel: knockback + server env-damage + hit flash.
  // Identical at every onHit/onSting/onClaw/onBoltHit site.
  function hurtPlayer(fromPos: THREE.Vector3, force: number, damage: number): void {
    deps.player().applyKnockback(fromPos, force);
    deps.networkManager()?.sendEnvironmentDamage(damage);
    deps.hud().showHitMarker();
  }

  // Compact orange pop shared by turret shells, totem bolts, mines — reads
  // as a small explosion, not a rocket.
  function boltPop(pos: THREE.Vector3, scale: number, color: number, shake: number): void {
    deps.world.explosions.push(new Explosion(scene, pos, false, 0, deps.terrain(), scale, color));
    screenShake.blast(pos, shake, deps.player().pos);
  }

  // One ambient species: a live-count cap, a spawn cadence timer, and a
  // per-frame update + disposal pass over its registry. The per-species
  // blocks below are all this shape — the table kills the copy-paste.
  interface Species<T extends Targetable & { dispose(): void }> {
    list: T[];
    interval: number;
    t: number;
    spawn: () => void;
    tick: (e: T, dt: number) => void;
  }
  // AI LOD — distant enemies tick at reduced rate so swarm counts don't
  // scale the CPU linearly. Accumulated dt keeps AI math time-correct;
  // 20Hz mid / 5Hz far is invisible at those distances.
  const AI_LOD_MID_SQ = 120 * 120;
  const AI_LOD_FAR_SQ = 300 * 300;
  const AI_LOD_MID_DT = 1 / 20;
  const AI_LOD_FAR_DT = 1 / 5;
  const lodAcc = new WeakMap<Targetable, number>();

  function updateSpecies<T extends Targetable & { dispose(): void }>(s: Species<T>, dt: number): void {
    s.t += dt;
    if (s.t >= s.interval) {
      s.t = 0;
      // Ambient spawning is owned by this one path — director spawns are
      // gated in gameLoop. (Per-species spawn fns that guard on isPlaying
      // anyway are harmless defense — director events call them directly.)
      if (!deps.demoManager()?.isPlaying) s.spawn();
    }
    const playerPos = deps.player().pos;
    for (let i = s.list.length - 1; i >= 0; i--) {
      const e = s.list[i]!;
      const dSq = e.pos.distanceToSquared(playerPos);
      if (dSq > AI_LOD_FAR_SQ) {
        const acc = (lodAcc.get(e) ?? 0) + dt;
        if (acc >= AI_LOD_FAR_DT) { lodAcc.set(e, 0); s.tick(e, acc); } else lodAcc.set(e, acc);
      } else if (dSq > AI_LOD_MID_SQ) {
        const acc = (lodAcc.get(e) ?? 0) + dt;
        if (acc >= AI_LOD_MID_DT) { lodAcc.set(e, 0); s.tick(e, acc); } else lodAcc.set(e, acc);
      } else {
        s.tick(e, dt);
      }
      if (e.dead) {
        lodAcc.delete(e);
        e.dispose();
        removeTarget(s.list, i, e);
      }
    }
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
    spawnBallOfVariant(pickVariant());
  }

  // Shared spawn path — director events need to spawn specific variants
  function spawnBallOfVariant(variant: 0 | 1 | 2 | 3): Ball {
    const dm = deps.demoManager();
    const ball = new Ball(scene, deps.terrain(), variant);
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
    if (deps.demoManager()?.isPlaying) return;
    spawnBallOfVariant(3);
  }

  // Elite death: two variant-0 balls burst out of the corpse with divergent
  // velocities. Kill-it-close = you're suddenly fighting two balls point-blank;
  // kill-it-far = free loot. The decision IS the mechanic.
  function spawnSplitChildren(t: Targetable): void {
    if (deps.demoManager()?.isPlaying) return;
    const dm = deps.demoManager();
    for (let k = 0; k < 2; k++) {
      const child = new Ball(scene, deps.terrain(), 0);
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
  function spawnCrawler(pos?: THREE.Vector3): void {
    if (!pos && crawlers.filter(c => !c.dead).length >= CRAWLER_MAX) return; // events bypass the cap
    const c = new Crawler(scene, deps.terrain(), pos ?? ringPos(CRAWLER_SPAWN_MIN, CRAWLER_SPAWN_MAX));
    c.onLanded = (p) => deps.effects().spawnJumpDust(p);
    c.onPounceHit = (cr) => hurtPlayer(cr.pos, 10, CRAWLER_POUNCE_DAMAGE);
    crawlers.push(c);
    targets.push(c);
  }

  const crawlerSpecies: Species<Crawler> = {
    // Negative t = first-spawn delay — the run breathes in before pressure
    list: crawlers, interval: CRAWLER_SPAWN_INTERVAL, t: -18,
    spawn: spawnCrawler,
    tick: (c, dt) => c.update(dt, deps.terrain(), deps.player().pos),
  };
  function updateCrawlers(dt: number): void { updateSpecies(crawlerSpecies, dt); }

  // ---- Turretters (plant-and-shell enemies that lob themselves at you) ----
  function spawnTurretter(): void {
    if (turrets.filter(t => !t.dead).length >= TURRET_MAX) return;
    const player = deps.player();
    const t = new Turretter(scene, deps.terrain(), ringPos(TURRET_SPAWN_MIN, TURRET_SPAWN_MAX));
    t.onLanded = (pos) => boltPop(pos, 0.4, 0xff8844, 2.4);
    t.onLaunch = (pos) => deps.effects().spawnJumpDust(pos);
    t.onBoltLand = (pos) => boltPop(pos, 0.3, 0xffaa44, 1.8);
    t.onBoltHit = () => {
      boltPop(player.pos.clone(), 0.3, 0xffaa44, 1.8);
      hurtPlayer(t.pos, 6, TURRET_BOLT_DAMAGE);
    };
    turrets.push(t);
    targets.push(t);
  }

  const turretSpecies: Species<Turretter> = {
    list: turrets, interval: TURRET_SPAWN_INTERVAL, t: -70,
    spawn: spawnTurretter,
    tick: (t, dt) => t.update(dt, deps.terrain(), deps.player().pos, deps.player().vel),
  };
  function updateTurrets(dt: number): void { updateSpecies(turretSpecies, dt); }

  // ---- Rollers (big homing boulders — the hitbox is the threat) ----
  function spawnRoller(): void {
    if (rollers.filter(r => !r.dead).length >= ROLLER_MAX) return;
    const r = new Roller(scene, deps.terrain(), ringPos(ROLLER_SPAWN_MIN, ROLLER_SPAWN_MAX));
    r.onLanded = (pos) => deps.effects().spawnJumpDust(pos);
    r.onHit = (rl) => hurtPlayer(rl.pos, ROLLER_HIT_FORCE, ROLLER_HIT_DAMAGE);
    rollers.push(r);
    targets.push(r);
  }

  const rollerSpecies: Species<Roller> = {
    list: rollers, interval: ROLLER_SPAWN_INTERVAL, t: -55,
    spawn: spawnRoller,
    tick: (r, dt) => r.update(dt, deps.terrain(), deps.player().pos),
  };
  function updateRollers(dt: number): void { updateSpecies(rollerSpecies, dt); }

  // ---- Seekers (airborne sting enemies — telegraphed darts) ----
  function spawnSeeker(): void {
    if (seekers.filter(s => !s.dead).length >= SEEKER_MAX) return;
    const s = new Seeker(scene, deps.terrain(), ringPos(SEEKER_SPAWN_MIN, SEEKER_SPAWN_MAX));
    s.onSting = (sk) => hurtPlayer(sk.pos, SEEKER_STING_FORCE, SEEKER_STING_DAMAGE);
    seekers.push(s);
    targets.push(s);
  }

  const seekerSpecies: Species<Seeker> = {
    list: seekers, interval: SEEKER_SPAWN_INTERVAL, t: -40,
    spawn: spawnSeeker,
    tick: (s, dt) => s.update(dt, deps.terrain(), deps.player().pos),
  };
  function updateSeekers(dt: number): void { updateSpecies(seekerSpecies, dt); }

  // ---- Miners + mines (burrowing zone-denial — punishes camping) ----
  function plantMine(pos: THREE.Vector3): void {
    // Cap the field: dropping a new mine past the cap retires the oldest
    if (mines.length >= MINE_MAX) {
      const oldest = mines.shift()!;
      oldest.onDetonate = undefined; // retires quietly — no fake explosion
      oldest.dead = true;
      oldest.dispose();
      const ti = targets.indexOf(oldest);
      if (ti >= 0) targets.splice(ti, 1);
    }
    const m = new Mine(scene, deps.terrain(), pos);
    const player = deps.player();
    m.onDetonate = (mine) => {
      // Mine pop — compact dirty-orange blast, not a rocket
      deps.world.explosions.push(new Explosion(scene, mine.pos, false, 0, deps.terrain(), MINE_BLAST_RADIUS / ROCKET_RADIUS, 0xff7733));
      screenShake.blast(mine.pos, 2.5, player.pos);
      // Player proximity damage — same env-damage path as crawler pounces
      const dist = mine.pos.distanceTo(player.pos);
      if (dist < MINE_BLAST_RADIUS) {
        const dmg = Math.round(MINE_DAMAGE_MAX * (1 - dist / MINE_BLAST_RADIUS));
        if (dmg > 0) {
          player.applyKnockback(mine.pos, MINE_KNOCKBACK);
          deps.networkManager()?.sendEnvironmentDamage(dmg);
          deps.hud().showHitMarker();
        }
      }
    };
    mines.push(m);
    targets.push(m);
  }

  function spawnMiner(): void {
    // Also called by director events — the species loop isn't the only caller
    if (deps.demoManager()?.isPlaying) return;
    if (miners.filter(m => !m.dead).length >= MINER_MAX) return;
    const m = new Miner(scene, deps.terrain(), ringPos(MINER_SPAWN_MIN, MINER_SPAWN_MAX));
    m.onMineDrop = (miner) => {
      plantMine(miner.pos); // Mine clamps itself to the terrain below
      deps.effects().spawnJumpDust(miner.pos); // belly puff marks the drop
    };
    miners.push(m);
    targets.push(m);
  }

  const minerSpecies: Species<Miner> = {
    list: miners, interval: MINER_SPAWN_INTERVAL, t: -100,
    spawn: spawnMiner,
    tick: (m, dt) => m.update(dt, deps.terrain(), deps.player().pos),
  };
  function updateMiners(dt: number): void {
    updateSpecies(minerSpecies, dt);
    const player = deps.player();
    for (let i = mines.length - 1; i >= 0; i--) {
      const m = mines[i]!;
      m.update(dt, player.pos);
      if (m.dead) {
        m.dispose();
        removeTarget(mines, i, m);
      }
    }
  }

  // ---- Totems (peak-seeking sniper obelisks) ----
  function spawnTotem(): void {
    if (deps.demoManager()?.isPlaying) return;
    if (totems.filter(t => !t.dead).length >= TOTEM_MAX) return;
    const player = deps.player();
    const t = new Totem(scene, deps.terrain(), ringPos(TOTEM_SPAWN_MIN, TOTEM_SPAWN_MAX));
    t.onBoltLand = (pos) => boltPop(pos, 0.35, 0xff5566, 2.0);
    t.onBoltHit = () => {
      boltPop(player.pos.clone(), 0.35, 0xff5566, 2.0);
      hurtPlayer(t.pos, 8, TOTEM_BOLT_DAMAGE);
    };
    t.onBlink = (pos) => deps.effects().spawnJumpDust(pos); // departure puff at the old spot
    totems.push(t);
    targets.push(t);
  }

  const totemSpecies: Species<Totem> = {
    list: totems, interval: TOTEM_SPAWN_INTERVAL, t: -120,
    spawn: spawnTotem,
    tick: (t, dt) => t.update(dt, deps.terrain(), deps.player().pos, deps.player().vel),
  };
  function updateTotems(dt: number): void { updateSpecies(totemSpecies, dt); }

  // ---- Rakks (circling cliff-racers — fold-and-swoop passes) ----
  function spawnRakk(): void {
    if (deps.demoManager()?.isPlaying) return;
    if (rakks.filter(r => !r.dead).length >= RAKK_MAX) return;
    const r = new Rakk(scene, deps.terrain(), ringPos(RAKK_SPAWN_MIN, RAKK_SPAWN_MAX));
    r.onClawHit = (rk) => hurtPlayer(rk.pos, RAKK_CLAW_FORCE, RAKK_CLAW_DAMAGE);
    r.onDive = (rk) => deps.effects().spawnJumpDust(rk.pos); // wing-tuck puff — silhouette cue
    rakks.push(r);
    targets.push(r);
  }

  const rakkSpecies: Species<Rakk> = {
    list: rakks, interval: RAKK_SPAWN_INTERVAL, t: -80,
    spawn: spawnRakk,
    tick: (r, dt) => r.update(dt, deps.terrain(), deps.player().pos),
  };
  function updateRakks(dt: number): void { updateSpecies(rakkSpecies, dt); }

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
    balls, crawlers, turrets, rollers, seekers, miners, mines, totems, rakks, targets, nuggets,
    getNuggetsCollected: () => nuggetsCollected,
    spawnBall, spawnCrawler, spawnTurretter, spawnRoller, spawnSeeker, spawnMiner, spawnTotem, spawnRakk,
    spawnEliteBall, plantMine,
    updateBalls, updateCrawlers, updateTurrets, updateRollers, updateSeekers, updateMiners, updateTotems, updateRakks, updateNuggets,
    recordBallKeyframes,
  };
}
