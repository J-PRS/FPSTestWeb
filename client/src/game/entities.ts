import * as THREE from 'three';

import {
  BALL_SPAWN_INTERVAL, BALL_MAX,
  CRAWLER_MAX, CRAWLER_SPAWN_INTERVAL, CRAWLER_SPAWN_MIN, CRAWLER_SPAWN_MAX, CRAWLER_POUNCE_DAMAGE,
  SCARAB_MAX, SCARAB_SPAWN_INTERVAL, SCARAB_SPAWN_MIN, SCARAB_SPAWN_MAX,
  SCARAB_PACK_MIN, SCARAB_PACK_MAX, SCARAB_BITE_DAMAGE, SCARAB_BITE_FORCE, SCARAB_BITE_DIST,
  GRUB_MAX, GRUB_SPAWN_INTERVAL, GRUB_SPAWN_MIN, GRUB_SPAWN_MAX,
  GRUB_BITE_DAMAGE, GRUB_BITE_FORCE, GRUB_BITE_DIST,
  SNAKE_MAX, SNAKE_SPAWN_INTERVAL, SNAKE_SPAWN_MIN, SNAKE_SPAWN_MAX,
  SNAKE_BITE_DAMAGE, SNAKE_BITE_FORCE, SNAKE_BITE_DIST,
  GNAT_MAX, GNAT_SPAWN_INTERVAL, GNAT_SPAWN_MIN, GNAT_SPAWN_MAX,
  GNAT_CLOUD_MIN, GNAT_CLOUD_MAX, GNAT_ORBIT_ALT,
  GNAT_NIP_DAMAGE, GNAT_NIP_FORCE, GNAT_NIP_DIST,
  TURRET_MAX, TURRET_SPAWN_INTERVAL, TURRET_SPAWN_MIN, TURRET_SPAWN_MAX, TURRET_BOLT_DAMAGE,
  ROLLER_MAX, ROLLER_SPAWN_INTERVAL, ROLLER_SPAWN_MIN, ROLLER_SPAWN_MAX,
  ROLLER_HIT_DAMAGE, ROLLER_HIT_FORCE,
  SEEKER_MAX, SEEKER_SPAWN_INTERVAL, SEEKER_SPAWN_MIN, SEEKER_SPAWN_MAX,
  SEEKER_STING_DAMAGE, SEEKER_STING_FORCE, SEEKER_STING_DIST,
  OVERLORD_MAX, OVERLORD_SPAWN_INTERVAL, OVERLORD_SPAWN_MIN, OVERLORD_SPAWN_MAX,
  MINE_MAX, MINE_DAMAGE_MAX, MINE_KNOCKBACK,
  BANELING_MAX, BANELING_DAMAGE_MAX, BANELING_KNOCKBACK,
  TOTEM_MAX, TOTEM_SPAWN_INTERVAL, TOTEM_SPAWN_MIN, TOTEM_SPAWN_MAX,
  TOTEM_BOLT_DAMAGE, UBER_TOTEM_MAX, UBER_TOTEM_BOLT_DAMAGE,
  RAKK_MAX, RAKK_SPAWN_INTERVAL, RAKK_SPAWN_MIN, RAKK_SPAWN_MAX,
  RAKK_CLAW_DAMAGE, RAKK_CLAW_FORCE, RAKK_CLAW_DIST,
  WEED_MAX, WEED_SPAWN_INTERVAL, WEED_SPAWN_MIN, WEED_SPAWN_MAX,
  WEED_WIND_X, WEED_WIND_Z,
  ROCKET_RADIUS, // Explosion VFX scale reference — blast visuals normalize to it
} from '../core/config.js';
import * as sfx from '../core/sfx.js';
import { createNetBalls } from './netBalls.js';
import { createSpeciesKit, type Species } from './speciesKit.js';
import { PROFILES } from './targeting.js';
import { Ball, pickVariant, type Targetable } from '../entities/balls.js';
import { Crawler } from '../entities/Crawler.js';
import { Scarab } from '../entities/Scarab.js';
import { Grub } from '../entities/Grub.js';
import { Snake } from '../entities/Snake.js';
import { Gnat } from '../entities/Gnat.js';
import { Nugget } from '../entities/Nugget.js';
import { Overlord } from '../entities/Overlord.js';
import { Mine } from '../entities/Mine.js';
import { Baneling } from '../entities/Baneling.js';
import { Rakk } from '../entities/Rakk.js';
import { Roller } from '../entities/Roller.js';
import { Seeker } from '../entities/Seeker.js';
import { Totem } from '../entities/Totem.js';
import { Turretter, type Bolt } from '../entities/Turretter.js';
import { Tumbleweed } from '../entities/Tumbleweed.js';
import { Explosion } from '../effects/explosion.js';
import { screenShake } from '../effects/screenShake.js';
import type { GameContext } from './context.js';

export interface EntitiesDeps extends GameContext {
  // scene/camera exist before entities is constructed — eager refs, no lazy needed
  scene: THREE.Scene;
  camera: THREE.Camera;
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
  const scarabs: Scarab[] = [];
  const grubs: Grub[] = [];
  const snakes: Snake[] = [];
  const gnats: Gnat[] = [];
  // Live gnat clouds — members share these objects; centers chase the player
  const gnatClouds: { center: THREE.Vector3; nipGate: number }[] = [];
  const turrets: Turretter[] = [];
  const rollers: Roller[] = [];
  const seekers: Seeker[] = [];
  const overlords: Overlord[] = [];
  const mines: Mine[] = [];
  const banelings: Baneling[] = [];
  const totems: Totem[] = [];
  const rakks: Rakk[] = [];
  const weeds: Tumbleweed[] = [];
  const targets: Targetable[] = [];
  const nuggets: Nugget[] = [];
  let nuggetsCollected = 0;

  let ballTimer = 0;
  let ballSnapshotTimer = 0;

  // Shared species machinery (threat tables, damage funnel, spawn ring,
  // LOD ticking, dust/bolt emitters) lives in game/speciesKit.ts.
  const kit = createSpeciesKit(deps, targets);
  const {
    removeTarget, ringPos, hurtPlayer,
    aggroFor, aggroVelFor, reportTargetDamage,
    boltPop, updateSpecies, burrow, rollUber, kickDust, kickTrail,
  } = kit;

  // ---- Nuggets (pickup gems dropped by destroyed targets) ----
  function updateNuggets(dt: number): void {
    const terrain = deps.lazyTerrain();
    for (let i = nuggets.length - 1; i >= 0; i--) {
      const n = nuggets[i]!;
      n.update(dt, terrain, deps.lazyPlayer().pos);
      if (n.collected && !n.collectNotified) {
        n.collectNotified = true;
        nuggetsCollected++;
        deps.lazyPlayer().grantJetBoost();
        deps.lazyPlayer().heal(0.2); // 20% max hp per nugget
        deps.lazyNetworkManager()?.sendHeal(20); // server stays the truth — clamped 25/call
        deps.lazyEffects().spawnImpact(n.pos, n.vel);
        sfx.pickup();
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
    const dm = deps.lazyDemoManager();
    if (!dm?.isRecording) return;
    ball.onBounce = (pos, vel) => {
      dm.recordTargetBounce(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);
    };
    ball.onPeak = (pos, vel) => {
      dm.recordTargetPeak(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);
    };
  }

  // Server-owned ball lifecycle (ballSpawn/ballSegment/ballDie handlers +
  // the stamped-sim-time clock) lives in game/netBalls.ts.
  const netBalls = createNetBalls(deps, { balls, targets, nuggets }, logger);
  const { serverBalls, netBallSpawn, netBallSegment, netBallDie, netTargetPosFor } = netBalls;

  // ---- Balls ----
  function spawnBall(): void {
    const dm = deps.lazyDemoManager();
    if (dm?.isPlaying) return; // skip normal spawning during demo playback
    if (serverBalls()) return; // connected: the server owns ball spawning
    if (balls.filter(b => !b.dead).length >= BALL_MAX) return;
    spawnBallOfVariant(pickVariant());
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
    if (serverBalls()) return;
    spawnBallOfVariant(3);
  }

  // Elite death: two variant-0 balls burst out of the corpse with divergent
  // velocities. Kill-it-close = you're suddenly fighting two balls point-blank;
  // kill-it-far = free loot. The decision IS the mechanic.
  function spawnSplitChildren(t: Targetable): void {
    if (deps.lazyDemoManager()?.isPlaying) return;
    if (serverBalls()) return;
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

    const netMode = serverBalls();
    ballTimer += dt;
    if (!netMode && ballTimer >= BALL_SPAWN_INTERVAL) {
      ballTimer = 0;
      spawnBall();
    }

    Ball.viewPos.copy(camera.position); // feeds billboarded ball ribbon trails
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i]!;
      if (netMode && !b.netDriven && !b.dead) b.netKill(); // cull pre-connect locals
      b.update(dt, deps.lazyTerrain(), b.netDriven ? netTargetPosFor(b) : aggroFor(b, b.pos, dt, PROFILES.fodder));
      kickDust(b, dt); // bounce frames puff — airborne frames don't
      // Only remove ball when trails have fully faded out
      if (b.disposed) removeTarget(balls, i, b);
    }

    recordBallSnapshots(dt);
  }

  // ---- Crawlers (terrain-hugging targets that pounce) ----
  function spawnCrawler(pos?: THREE.Vector3, uber?: boolean): void {
    if (!pos && crawlers.filter(c => !c.dead).length >= CRAWLER_MAX) return; // events bypass the cap
    const u = uber ?? (!pos && rollUber());
    const c = new Crawler(scene, deps.lazyTerrain(), pos ?? ringPos(CRAWLER_SPAWN_MIN, CRAWLER_SPAWN_MAX), u);
    c.onLanded = (p) => { deps.lazyEffects().spawnJumpDust(p); sfx.enemyCue(p, 'skitter'); };
    c.onPounceHit = (cr) => hurtPlayer(cr.pos, 10, CRAWLER_POUNCE_DAMAGE * (cr.uber ? 2 : 1),
      cr.uber ? 'devoured by the matriarch' : 'devoured by a crawler', cr.radius + 3, cr);
    c.onBrood = (cr) => {
      // Matriarch births a scarab — cap-checked, positioned just off her hip
      if (scarabs.filter(s => !s.dead).length >= SCARAB_MAX) return;
      const s = new Scarab(scene, deps.lazyTerrain(), cr.pos.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3)));
      s.onBite = (sc) => hurtPlayer(sc.pos, SCARAB_BITE_FORCE, SCARAB_BITE_DAMAGE, 'swarmed by scarabs', sc.radius + SCARAB_BITE_DIST + 1, sc);
      s.onLanded = (p) => deps.lazyEffects().spawnJumpDust(p);
      scarabs.push(s);
      targets.push(s);
      deps.lazyEffects().spawnJumpDust(cr.pos);
    };
    if (!pos) burrow(c); // event/demo spawns pass an explicit pos — those appear, not burrow
    crawlers.push(c);
    targets.push(c);
  }

  const crawlerSpecies: Species<Crawler> = {
    // Negative t = first-spawn delay — the run breathes in before pressure
    list: crawlers, interval: CRAWLER_SPAWN_INTERVAL, t: -18,
    spawn: spawnCrawler,
    tick: (c, dt) => { c.update(dt, deps.lazyTerrain(), aggroFor(c, c.pos, dt, PROFILES.hunter)); kickDust(c, dt); },
  };
  function updateCrawlers(dt: number): void { updateSpecies(crawlerSpecies, dt); }

  // ---- Scarabs (pack fodder — mow them down in clumps) ----
  function spawnScarab(pos?: THREE.Vector3, uber?: boolean): void {
    if (!pos && scarabs.filter(s => !s.dead).length >= SCARAB_MAX) return;
    const u = uber ?? (!pos && rollUber());
    // One spawn attempt = a whole pack, clustered on the same burrow spot.
    // An uber roll drops ONE dreadbeetle instead — a pack of those is a raid boss.
    const base = pos ?? ringPos(SCARAB_SPAWN_MIN, SCARAB_SPAWN_MAX);
    const n = u ? 1 : pos ? 1 : SCARAB_PACK_MIN + Math.floor(Math.random() * (SCARAB_PACK_MAX - SCARAB_PACK_MIN + 1));
    for (let k = 0; k < n; k++) {
      if (scarabs.filter(s => !s.dead).length >= SCARAB_MAX) break;
      const s = new Scarab(scene, deps.lazyTerrain(), base.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)), u);
      s.onBite = (sc) => hurtPlayer(sc.pos,
        SCARAB_BITE_FORCE * (sc.uber ? 2.5 : 1), SCARAB_BITE_DAMAGE * (sc.uber ? 3 : 1),
        sc.uber ? 'trampled by a dreadbeetle' : 'swarmed by scarabs', sc.radius + SCARAB_BITE_DIST + 1, sc);
      s.onLanded = (p) => deps.lazyEffects().spawnJumpDust(p);
      if (!pos) burrow(s);
      scarabs.push(s);
      targets.push(s);
    }
  }

  const scarabSpecies: Species<Scarab> = {
    list: scarabs, interval: SCARAB_SPAWN_INTERVAL, t: -8, // fodder arrives early — it's the tutorial swarm
    spawn: spawnScarab,
    tick: (s, dt) => { s.update(dt, deps.lazyTerrain(), aggroFor(s, s.pos, dt, PROFILES.hunter)); kickDust(s, dt); },
  };
  function updateScarabs(dt: number): void { updateSpecies(scarabSpecies, dt); }

  // ---- Grubs (walking piñatas — slow, fat, poppable) ----
  function spawnGrub(pos?: THREE.Vector3, uber?: boolean): void {
    if (!pos && grubs.filter(g => !g.dead).length >= GRUB_MAX) return;
    const u = uber ?? (!pos && rollUber());
    const g = new Grub(scene, deps.lazyTerrain(), pos ?? ringPos(GRUB_SPAWN_MIN, GRUB_SPAWN_MAX), u);
    g.onBite = (gr) => hurtPlayer(gr.pos, GRUB_BITE_FORCE * (gr.uber ? 2 : 1),
      GRUB_BITE_DAMAGE * (gr.uber ? 2 : 1),
      gr.uber ? 'crushed by a bloatgrub' : 'gummed to death by a grub', gr.radius + GRUB_BITE_DIST + 1, gr);
    if (u) g.onDeath = (mother) => {
      // Bloatgrub births on pop: three live grubs spill out of the corpse —
      // cap-checked so a bloatgrub chain can't flood the field.
      for (let k = 0; k < 3 && grubs.filter(x => !x.dead).length < GRUB_MAX; k++) {
        const child = new Grub(scene, deps.lazyTerrain(), mother.pos.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2)));
        child.onBite = g.onBite; // same wiring — children are normal grubs
        grubs.push(child);
        targets.push(child);
      }
      deps.lazyEffects().spawnJumpDust(mother.pos);
    };
    if (!pos) burrow(g);
    grubs.push(g);
    targets.push(g);
  }

  const grubSpecies: Species<Grub> = {
    list: grubs, interval: GRUB_SPAWN_INTERVAL, t: -5,
    spawn: spawnGrub,
    tick: (g, dt) => { g.update(dt, deps.lazyTerrain(), aggroFor(g, g.pos, dt, PROFILES.fodder)); kickDust(g, dt); },
  };
  function updateGrubs(dt: number): void { updateSpecies(grubSpecies, dt); }

  // ---- Snakes (sand vipers — weave in, coil, lunge) ----
  function spawnSnake(pos?: THREE.Vector3, uber?: boolean): void {
    if (!pos && snakes.filter(s => !s.dead).length >= SNAKE_MAX) return;
    const u = uber ?? (!pos && rollUber());
    const s = new Snake(scene, deps.lazyTerrain(), pos ?? ringPos(SNAKE_SPAWN_MIN, SNAKE_SPAWN_MAX), u);
    s.onStrike = (sn) => hurtPlayer(sn.pos,
      SNAKE_BITE_FORCE * (sn.uber ? 2 : 1), SNAKE_BITE_DAMAGE * (sn.uber ? 2.5 : 1),
      sn.uber ? 'swallowed by the king serpent' : 'bitten by a sand viper', sn.radius + SNAKE_BITE_DIST + 1, sn);
    if (!pos) burrow(s);
    snakes.push(s);
    targets.push(s);
  }

  const snakeSpecies: Species<Snake> = {
    list: snakes, interval: SNAKE_SPAWN_INTERVAL, t: -30,
    spawn: spawnSnake,
    tick: (s, dt) => { s.update(dt, deps.lazyTerrain(), aggroFor(s, s.pos, dt, PROFILES.hunter)); kickDust(s, dt); },
  };
  function updateSnakes(dt: number): void { updateSpecies(snakeSpecies, dt); }

  // ---- Gnats (boid harasser cloud — orbits you, darts for nips) ----
  function spawnGnatCloud(uber?: boolean): void {
    if (gnats.filter(g => !g.dead).length >= GNAT_MAX) return;
    const u = uber ?? rollUber();
    const base = ringPos(GNAT_SPAWN_MIN, GNAT_SPAWN_MAX);
    const player = deps.lazyPlayer();
    const cloud = {
      center: new THREE.Vector3(
        player.pos.x + (Math.random() - 0.5) * 30,
        deps.lazyTerrain().getHeight(base.x, base.z) + GNAT_ORBIT_ALT + 8,
        player.pos.z + (Math.random() - 0.5) * 30,
      ),
      nipGate: 0,
    };
    gnatClouds.push(cloud);
    // Uber roll = a QUEEN — one big tanky gnat with a small escort retinue,
    // not a whole cloud of queens.
    const n = u
      ? 1 + Math.floor(Math.random() * 3) + 2      // queen + 2-4 escorts
      : GNAT_CLOUD_MIN + Math.floor(Math.random() * (GNAT_CLOUD_MAX - GNAT_CLOUD_MIN + 1));
    for (let k = 0; k < n; k++) {
      if (gnats.filter(g => !g.dead).length >= GNAT_MAX) break;
      const queen = u && k === 0; // firstborn is the queen
      const g = new Gnat(scene, deps.lazyTerrain(), cloud.center.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8)), queen);
      g.joinCloud(cloud);
      g.onNip = (gn) => hurtPlayer(gn.pos,
        GNAT_NIP_FORCE * (gn.uber ? 2 : 1), GNAT_NIP_DAMAGE * (gn.uber ? 3 : 1),
        gn.uber ? 'drained by the gnat queen' : 'drained by gnats', gn.radius + GNAT_NIP_DIST + 2, gn);
      gnats.push(g);
      targets.push(g);
    }
  }

  const gnatSpecies: Species<Gnat> = {
    list: gnats, interval: GNAT_SPAWN_INTERVAL, t: -25,
    spawn: spawnGnatCloud,
    tick: (g, dt) => g.update(dt, deps.lazyTerrain(), aggroFor(g, g.pos, dt, PROFILES.flyer)),
  };
  function updateGnats(dt: number): void {
    // Cloud centers stalk the player loosely — the swarm hovers over you
    // and drifts along as you move, never quite settling. Each cloud gets
    // its own brain: in shared PvE a cloud picks a victim and stalks THEM.
    for (let i = gnatClouds.length - 1; i >= 0; i--) {
      const c = gnatClouds[i]!;
      // Retire clouds with no living members
      if (!gnats.some(g => !g.dead && g.cloud === c)) {
        gnatClouds.splice(i, 1);
        continue;
      }
      const t = aggroFor(c, c.center, dt, PROFILES.flyer);
      const gy = deps.lazyTerrain().getHeight(t.x, t.z);
      _gnatTarget.set(t.x, Math.max(gy, t.y) + GNAT_ORBIT_ALT, t.z);
      c.center.lerp(_gnatTarget, Math.min(1, dt * 0.5)); // lazy stalk
    }
    updateSpecies(gnatSpecies, dt);
  }
  const _gnatTarget = new THREE.Vector3();

  // ---- Turretters (plant-and-shell enemies that lob themselves at you) ----
  function spawnTurretter(uber?: boolean): void {
    if (turrets.filter(t => !t.dead).length >= TURRET_MAX) return;
    const u = uber ?? rollUber();
    const player = deps.lazyPlayer();
    const t = new Turretter(scene, deps.lazyTerrain(), ringPos(TURRET_SPAWN_MIN, TURRET_SPAWN_MAX), u);
    t.onLanded = (pos) => boltPop(pos, 0.4, 0xff8844, 2.4);
    t.onLaunch = (pos) => { deps.lazyEffects().spawnJumpDust(pos); sfx.enemyCue(pos, 'launch'); };
    t.onBoltLand = (pos) => boltPop(pos, 0.3, 0xffaa44, 1.8);
    t.onBoltHit = () => {
      boltPop(player.pos.clone(), 0.3, 0xffaa44, 1.8);
      hurtPlayer(t.pos, 6, TURRET_BOLT_DAMAGE * (t.uber ? 1.5 : 1),
        t.uber ? 'shelled by a siege engine' : 'shelled by a turretter',
        undefined, t);
    };
    turrets.push(t);
    targets.push(t);
  }

  const turretSpecies: Species<Turretter> = {
    list: turrets, interval: TURRET_SPAWN_INTERVAL, t: -70,
    spawn: spawnTurretter,
    tick: (t, dt) => t.update(dt, deps.lazyTerrain(), aggroFor(t, t.pos, dt, PROFILES.artillery), aggroVelFor(t)),
  };
  function updateTurrets(dt: number): void { updateSpecies(turretSpecies, dt); }

  // Turretter shells are shootable. `turretBolts` hands combat the live
  // list once per frame for the projectile sweep; `consumeBolt` removes
  // the intercepted one; `cookBoltsNear` chain-detonates bolts caught in
  // a cookoff blast (a mega explosion pops neighboring shells too).
  const _boltList: Bolt[] = [];
  function turretBolts(): Bolt[] {
    _boltList.length = 0;
    for (const t of turrets) {
      if (t.dead) continue;
      for (const b of t.bolts) _boltList.push(b);
    }
    return _boltList;
  }

  function consumeBolt(bolt: Bolt): void {
    for (const t of turrets) {
      const i = t.bolts.indexOf(bolt);
      if (i >= 0) { t.detonateBolt(i); return; }
    }
  }

  const _boltKills: THREE.Vector3[] = [];
  function cookBoltsNear(pos: THREE.Vector3, radius: number): THREE.Vector3[] {
    _boltKills.length = 0;
    const r2 = radius * radius;
    for (const t of turrets) {
      if (t.dead) continue;
      for (let i = t.bolts.length - 1; i >= 0; i--) {
        if (t.bolts[i].pos.distanceToSquared(pos) < r2) {
          _boltKills.push(t.bolts[i].pos.clone());
          t.detonateBolt(i);
        }
      }
    }
    return _boltKills;
  }

  // ---- Rollers (big homing boulders — the hitbox is the threat) ----
  function spawnRoller(uber?: boolean): void {
    if (rollers.filter(r => !r.dead).length >= ROLLER_MAX) return;
    const u = uber ?? rollUber();
    const r = new Roller(scene, deps.lazyTerrain(), ringPos(ROLLER_SPAWN_MIN, ROLLER_SPAWN_MAX), u);
    r.onLanded = (pos) => deps.lazyEffects().spawnJumpDust(pos);
    r.onHit = (rl) => hurtPlayer(rl.pos, ROLLER_HIT_FORCE * (rl.uber ? 1.5 : 1),
      ROLLER_HIT_DAMAGE * (rl.uber ? 2 : 1),
      rl.uber ? 'buried by an avalanche' : 'steamrolled by a boulder', rl.radius + 1.5, rl);
    burrow(r);
    rollers.push(r);
    targets.push(r);
  }

  const rollerSpecies: Species<Roller> = {
    list: rollers, interval: ROLLER_SPAWN_INTERVAL, t: -55,
    spawn: spawnRoller,
    tick: (r, dt) => { r.update(dt, deps.lazyTerrain(), aggroFor(r, r.pos, dt, PROFILES.rammer)); kickDust(r, dt); },
  };
  function updateRollers(dt: number): void { updateSpecies(rollerSpecies, dt); }

  // ---- Seekers (airborne sting enemies — telegraphed darts) ----
  function spawnSeeker(uber?: boolean): void {
    if (seekers.filter(s => !s.dead).length >= SEEKER_MAX) return;
    const u = uber ?? rollUber();
    const s = new Seeker(scene, deps.lazyTerrain(), ringPos(SEEKER_SPAWN_MIN, SEEKER_SPAWN_MAX), u);
    s.onSting = (sk) => hurtPlayer(sk.pos, SEEKER_STING_FORCE * (sk.uber ? 1.5 : 1),
      SEEKER_STING_DAMAGE * (sk.uber ? 2 : 1),
      sk.uber ? 'run through by a lancer' : 'stung to death by a seeker', sk.radius + SEEKER_STING_DIST + 1, sk);
    seekers.push(s);
    targets.push(s);
  }

  const seekerSpecies: Species<Seeker> = {
    list: seekers, interval: SEEKER_SPAWN_INTERVAL, t: -40,
    spawn: spawnSeeker,
    tick: (s, dt) => { s.update(dt, deps.lazyTerrain(), aggroFor(s, s.pos, dt, PROFILES.flyer), aggroVelFor(s)); kickTrail(s, dt); },
  };
  function updateSeekers(dt: number): void { updateSpecies(seekerSpecies, dt); }

  // ---- Overlords + mines (burrowing zone-denial — punishes camping) ----
  function plantMine(pos: THREE.Vector3, uber = false): void {
    // Cap the field: dropping a new mine past the cap retires the oldest
    if (mines.length >= MINE_MAX) {
      const oldest = mines.shift()!;
      oldest.onDetonate = undefined; // retires quietly — no fake explosion
      oldest.dead = true;
      oldest.dispose();
      const ti = targets.indexOf(oldest);
      if (ti >= 0) targets.splice(ti, 1);
    }
    const m = new Mine(scene, deps.lazyTerrain(), pos, uber);
    burrow(m); // planted mines bury themselves — thematic even from an Overlord drop
    const player = deps.lazyPlayer();
    m.onDetonate = (mine) => {
      // Mine pop — compact dirty-orange blast, not a rocket. Doombloom's
      // blastRadius field carries its doubled envelope.
      deps.world.explosions.push(new Explosion(scene, mine.pos, false, 0, deps.lazyTerrain(), mine.blastRadius / ROCKET_RADIUS, 0xff7733));
      sfx.explosionAt(mine.pos, true);
      screenShake.blast(mine.pos, mine.uber ? 4 : 2.5, player.pos);
      // Player proximity damage — same env-damage path as crawler pounces
      const dist = mine.pos.distanceTo(player.pos);
      if (dist < mine.blastRadius) {
        const dmg = Math.round(MINE_DAMAGE_MAX * (1 - dist / mine.blastRadius) * (mine.uber ? 1.5 : 1));
        if (dmg > 0) {
          player.lastDamageSource = mine.uber ? 'flowered by a doombloom' : 'blown up by a mine';
          player.applyKnockback(mine.pos, MINE_KNOCKBACK);
          deps.lazyNetworkManager()?.sendEnvironmentDamage(dmg);
          deps.lazyHud().showDamage(mine.pos, dmg);
        }
      }
      if (mine.uber) {
        // Doombloom chain: its blast sets off every OTHER mine it touches —
        // clearing a doombloom field by shooting one is a gamble, not a plan.
        // Each mine's own dead flag means the chain terminates naturally.
        for (const other of mines) {
          if (!other.dead && other !== mine && other.pos.distanceToSquared(mine.pos) < mine.blastRadius * mine.blastRadius) {
            other.takeDamage(); // any damage detonates a mine
          }
        }
      }
    };
    mines.push(m);
    targets.push(m);
  }

  // Overlord brood: green sac pop — same blast read as a mine, but rolling
  function spawnBaneling(pos: THREE.Vector3, uber = false): void {
    if (banelings.filter(b => !b.dead).length >= BANELING_MAX) return;
    const b = new Baneling(scene, deps.lazyTerrain(), pos, uber);
    if (b.dead) { b.dispose(); return; }
    const player = deps.lazyPlayer();
    b.onDetonate = (bane) => {
      // blastRadius is per-instance — a goliath pops 1.7× wider
      deps.world.explosions.push(new Explosion(scene, bane.pos, false, 0, deps.lazyTerrain(), bane.blastRadius / ROCKET_RADIUS, 0x77ff44));
      sfx.explosionAt(bane.pos, true);
      screenShake.blast(bane.pos, bane.uber ? 3.5 : 2.0, player.pos);
      const dist = bane.pos.distanceTo(player.pos);
      if (dist < bane.blastRadius) {
        const dmg = Math.round(BANELING_DAMAGE_MAX * (1 - dist / bane.blastRadius) * (bane.uber ? 1.4 : 1));
        if (dmg > 0) {
          player.lastDamageSource = bane.uber ? 'melted by a goliath' : 'melted by a baneling';
          player.applyKnockback(bane.pos, BANELING_KNOCKBACK);
          deps.lazyNetworkManager()?.sendEnvironmentDamage(dmg);
          deps.lazyHud().showDamage(bane.pos, dmg);
          sfx.playerHurt();
        }
      }
    };
    banelings.push(b);
    targets.push(b);
  }

  function spawnOverlord(uber?: boolean): void {
    // Also called by director events — the species loop isn't the only caller
    if (deps.lazyDemoManager()?.isPlaying) return;
    if (overlords.filter(m => !m.dead).length >= OVERLORD_MAX) return;
    const u = uber ?? rollUber();
    const m = new Overlord(scene, deps.lazyTerrain(), ringPos(OVERLORD_SPAWN_MIN, OVERLORD_SPAWN_MAX), u);
    m.onMineDrop = (overlord) => {
      spawnBaneling(overlord.pos); // drops to the terrain and immediately rolls
      if (overlord.uber) {
        // Broodmother twin drop — a second sac spills out right behind
        spawnBaneling(overlord.pos.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4)), rollUber());
      }
      deps.lazyEffects().spawnJumpDust(overlord.pos); // belly puff marks the birth
    };
    overlords.push(m);
    targets.push(m);
  }

  const overlordSpecies: Species<Overlord> = {
    list: overlords, interval: OVERLORD_SPAWN_INTERVAL, t: -100,
    spawn: spawnOverlord,
    tick: (m, dt) => { m.update(dt, deps.lazyTerrain(), aggroFor(m, m.pos, dt, PROFILES.siege)); kickTrail(m, dt); },
  };
  function updateOverlords(dt: number): void {
    updateSpecies(overlordSpecies, dt);
    for (let i = mines.length - 1; i >= 0; i--) {
      const m = mines[i]!;
      m.update(dt, aggroFor(m, m.pos, dt, PROFILES.fodder));
      if (m.dead) {
        m.dispose();
        removeTarget(mines, i, m);
      }
    }
    for (let i = banelings.length - 1; i >= 0; i--) {
      const b = banelings[i]!;
      b.update(dt, deps.lazyTerrain(), aggroFor(b, b.pos, dt, PROFILES.hunter));
      kickDust(b, dt);
      if (b.dead) {
        b.dispose();
        removeTarget(banelings, i, b);
      }
    }
  }

  // ---- Totems (peak-seeking sniper obelisks) ----
  function spawnTotem(): void {
    if (deps.lazyDemoManager()?.isPlaying) return;
    if (totems.filter(t => !t.dead).length >= TOTEM_MAX) return;
    const player = deps.lazyPlayer();
    const t = new Totem(scene, deps.lazyTerrain(), ringPos(TOTEM_SPAWN_MIN, TOTEM_SPAWN_MAX));
    t.onBoltLand = (pos) => boltPop(pos, 0.35, 0xff5566, 2.0);
    t.onBoltHit = () => {
      boltPop(player.pos.clone(), 0.35, 0xff5566, 2.0);
      hurtPlayer(t.pos, 8, TOTEM_BOLT_DAMAGE, 'struck down by a totem', undefined, t);
    };
    t.onBlink = (pos) => { deps.lazyEffects().spawnJumpDust(pos); sfx.enemyCue(pos, 'zap'); }; // departure puff at the old spot
    totems.push(t);
    targets.push(t);
  }

  // Uber totem — the elite sniper: predicts your velocity, tags a held
  // course. One at a time; the fat gold obelisk + wide death ray IS the tell.
  function spawnUberTotem(): void {
    if (deps.lazyDemoManager()?.isPlaying) return;
    if (totems.filter(t => !t.dead && t.uber).length >= UBER_TOTEM_MAX) return;
    const player = deps.lazyPlayer();
    const t = new Totem(scene, deps.lazyTerrain(), ringPos(TOTEM_SPAWN_MIN, TOTEM_SPAWN_MAX), true);
    t.onBoltLand = (pos) => boltPop(pos, 0.6, 0xffaa33, 3.0); // bigger ground scar
    t.onBoltHit = () => {
      boltPop(player.pos.clone(), 0.6, 0xffaa33, 3.0);
      hurtPlayer(t.pos, 14, UBER_TOTEM_BOLT_DAMAGE, 'sniped by the grand totem', undefined, t);
    };
    t.onBlink = (pos) => { deps.lazyEffects().spawnJumpDust(pos); sfx.enemyCue(pos, 'zap'); };
    totems.push(t);
    targets.push(t);
  }

  const totemSpecies: Species<Totem> = {
    list: totems, interval: TOTEM_SPAWN_INTERVAL, t: -120,
    spawn: spawnTotem,
    tick: (t, dt) => t.update(dt, deps.lazyTerrain(), aggroFor(t, t.pos, dt, PROFILES.sniper), aggroVelFor(t)),
  };
  function updateTotems(dt: number): void { updateSpecies(totemSpecies, dt); }

  // ---- Rakks (circling cliff-racers — fold-and-swoop passes) ----
  function spawnRakk(uber?: boolean): void {
    if (deps.lazyDemoManager()?.isPlaying) return;
    if (rakks.filter(r => !r.dead).length >= RAKK_MAX) return;
    const u = uber ?? rollUber();
    const r = new Rakk(scene, deps.lazyTerrain(), ringPos(RAKK_SPAWN_MIN, RAKK_SPAWN_MAX), u);
    r.onClawHit = (rk) => {
      const hit = hurtPlayer(rk.pos, RAKK_CLAW_FORCE * (rk.uber ? 1.5 : 1), RAKK_CLAW_DAMAGE * (rk.uber ? 2 : 1),
        rk.uber ? 'carried off by an elder rakk' : 'shredded by a rakk', rk.radius + RAKK_CLAW_DIST + 1, rk);
      if (hit && rk.uber) {
        // Elder talons hoist you — a claw hit throws you skyward, which is
        // worse than the damage when you're already committed to a ski line.
        const player = deps.lazyPlayer();
        player.vel.y += 14;
        player.vel.addScaledVector(rk.vel, 0.3);
      }
    };
    r.onDive = (rk) => { deps.lazyEffects().spawnJumpDust(rk.pos); sfx.enemyCue(rk.pos, 'dart'); }; // wing-tuck puff — silhouette cue
    rakks.push(r);
    targets.push(r);
  }

  const rakkSpecies: Species<Rakk> = {
    list: rakks, interval: RAKK_SPAWN_INTERVAL, t: -80,
    spawn: spawnRakk,
    tick: (r, dt) => { r.update(dt, deps.lazyTerrain(), aggroFor(r, r.pos, dt, PROFILES.flyer)); kickTrail(r, dt); },
  };
  function updateRakks(dt: number): void { updateSpecies(rakkSpecies, dt); }

  // ---- Tumbleweeds (destructible wind-blown props — ambience you can shoot) ----
  const weedWind = new THREE.Vector3(WEED_WIND_X, 0, WEED_WIND_Z).normalize();
  function spawnWeed(): void {
    if (weeds.filter(w => !w.dead).length >= WEED_MAX) return;
    const player = deps.lazyPlayer();
    // Spawn upwind so it rolls across the player's field of view; a lateral
    // jitter keeps the parade from becoming a conveyor line.
    const dist = WEED_SPAWN_MIN + Math.random() * (WEED_SPAWN_MAX - WEED_SPAWN_MIN);
    const side = (Math.random() - 0.5) * WEED_SPAWN_MAX;
    const pos = new THREE.Vector3(
      player.pos.x - weedWind.x * dist - weedWind.z * side,
      0,
      player.pos.z - weedWind.z * dist + weedWind.x * side,
    );
    // ~1 in 8 is a megaweed — 2x ball, 6x hp, 3 nuggets
    const w = new Tumbleweed(scene, deps.lazyTerrain(), pos, Math.random() < 0.125);
    burrow(w);
    weeds.push(w);
    targets.push(w);
  }

  const weedSpecies: Species<Tumbleweed> = {
    list: weeds, interval: WEED_SPAWN_INTERVAL, t: 0,
    spawn: spawnWeed,
    tick: (w, dt) => { w.update(dt, deps.lazyTerrain(), deps.lazyPlayer().pos); kickDust(w, dt); },
  };
  function updateWeeds(dt: number): void { updateSpecies(weedSpecies, dt); }

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

  return {
    balls, crawlers, scarabs, grubs, snakes, gnats, turrets, rollers, seekers, overlords, mines, totems, rakks, weeds, targets, nuggets,
    getNuggetsCollected: () => nuggetsCollected,
    spawnBall, spawnCrawler, spawnScarab, spawnGrub, spawnSnake, spawnGnatCloud, spawnTurretter, spawnRoller, spawnSeeker, spawnOverlord, spawnTotem, spawnUberTotem, spawnRakk,
    spawnEliteBall, plantMine, turretBolts, consumeBolt, cookBoltsNear,
    reportTargetDamage,
    netBallSpawn, netBallSegment, netBallDie,
    updateBalls, updateCrawlers, updateScarabs, updateGrubs, updateSnakes, updateGnats, updateTurrets, updateRollers, updateSeekers, updateOverlords, updateTotems, updateRakks, updateWeeds, updateNuggets,
    recordBallKeyframes,
  };
}
