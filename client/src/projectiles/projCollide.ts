import * as THREE from 'three';

import { classCapsule } from '../../../shared/botClasses.js';
import type { Targetable } from '../entities/balls.js';
import type { Terrain } from '../world/terrain.js';
import type { ProjectileConfig } from './types.js';
import * as sfx from '../core/sfx.js';
import { sweepTerrain, sweepBall, sweepPlayer, sweepObstacle, type SweepHost } from './sweep.js';
import { segSolidHit, type ColliderIndex } from '../../../shared/solidWorld.js';
import type { StructureCollider } from '../../../shared/ballSim.js';
import type { SweepObstacle } from './Projectile.js';

// Collision policy — the swept-contact rules (terrain bounce/fuse, wall
// hits, bolt interception, target hits + hit-record accounting). The
// segment math itself lives in sweep.ts; this file owns "what an impact
// does", split out of Projectile so the class stays lifecycle/mesh.

const _tNormal = new THREE.Vector3();

export interface CollideHost extends SweepHost {
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  lastDt: number;
  readonly config: ProjectileConfig;
  readonly shotOrigin: THREE.Vector3;
  readonly hitPoint: THREE.Vector3;
  hitPointValid: boolean;
  hitX: number; hitY: number; hitZ: number; hitT: number;
  minHitDist: number;
  hitAccuracy: number;
  hitAge: number;
  hitDistance: number;
  hitBall: Targetable | null;
  hitPlayerId: string | null;
  hitBolt: SweepObstacle | null;
  bouncesTaken: number;
  readonly armed: boolean;
  readonly canBounce: boolean;
  sweepLocal: (() => THREE.Vector3 | null) | null;
  /** Local player's armor class — the sweep needs its capsule size. */
  localClass: (() => string | undefined) | null;
  solids(): readonly StructureCollider[];
  solidIdx(): ColliderIndex | null;
  hitAt(x: number, y: number, z: number, t: number): void;
  stickAt(p: THREE.Vector3, ball?: Targetable, playerId?: string,
          remotePlayers?: Map<string, THREE.Vector3>): void;
  explode(): void;
}

export class ProjCollide {
  constructor(private h: CollideHost) {}

  // Runs all swept collision checks; returns true if the projectile hit
  // something and exploded (records hit target + accuracy data).
  checkCollisions(terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[], playerClasses?: Map<string, string>): boolean {
    const h = this.h;
    if (sweepTerrain(h, terrain)) {
      // arming fuse (T2 mortar): bounces only apply BEFORE the shell is armed
      if (h.canBounce && this.bounceOffTerrain(terrain)) {
        return false; // bounced — still live, fuse keeps running
      }
      if (h.config.sticks) {
        h.stickAt(h.hitPoint);
        return true;
      }
      h.explode();
      return true;
    }
    // Map structures next — walls stop shells like terrain does; without
    // this a mortar splashes the generator room straight through the roof.
    const solids = h.solids();
    if (solids.length) {
      const hit = segSolidHit(h.prevPos, h.pos, solids, h.solidIdx() ?? undefined);
      if (hit) {
        h.hitAt(hit.x, hit.y, hit.z, hit.t);
        if (h.config.sticks) {
          h.stickAt(h.hitPoint);
          return true;
        }
        h.explode();
        return true;
      }
    }
    // Obstacles (turret bolts) before targets: an interception is the
    // earliest contact worth reporting — the blast usually takes the
    // enemy anyway, and the cookoff is the interesting outcome.
    // passThroughTargets shells (MRV carrier) phase through bodies — a
    // contact pop would turn a timed airburst into a fast mortar. Bolts
    // and fields still intercept: shooting it down stays counterplay.
    if (h.config.passThroughTargets) return this.checkObstacles(obstacles);
    // Unarmed shells (mortar pre-armTime) phase through bodies — a
    // point-blank pop is exactly what the arming fuse exists to deny.
    // Bolts and shield domes still intercept: shooting it down is
    // counterplay, and a dome shouldn't let a dud inside.
    if (!h.armed) return this.checkObstacles(obstacles);
    return this.checkObstacles(obstacles) || this.checkBalls(balls) || this.checkPlayers(remotePlayers, playerClasses);
  }

  private checkObstacles(obstacles?: SweepObstacle[]): boolean {
    const h = this.h;
    if (!obstacles) return false;
    let best: SweepObstacle | null = null, bestT = Infinity;
    for (const o of obstacles) {
      // Filtered obstacles (shield domes) decide per-shell; unfiltered
      // ones (turret bolts) never intercept hitscan slugs — the guard
      // moved per-obstacle so a field still eats those.
      if (o.blocks ? !o.blocks(h as never) : h.config.noExplosion) continue;
      if (sweepObstacle(h, o) && h.hitT < bestT) { best = o; bestT = h.hitT; }
    }
    if (!best) return false;
    // Re-run the winning sweep so hitPoint/hitT describe ITS contact, not
    // a later bolt's — hitAt was overwritten by each tested obstacle.
    sweepObstacle(h, best);
    best.onBlocked?.(h as never);
    h.hitBolt = best;
    if (h.config.sticks) {
      // Shot down mid-flight — cook off on the spot, the bolt eats the pop.
      h.explode();
      return true;
    }
    h.explode();
    return true;
  }

  // Reflect velocity off the heightfield normal at hitPoint. Returns false
  // when the impact was too weak to bounce — caller should treat it as a
  // detonation instead of letting the shell sink or jitter in place.
  bounceOffTerrain(terrain: Terrain): boolean {
    const h = this.h;
    if (h.config.maxBounces !== undefined && ++h.bouncesTaken > h.config.maxBounces) {
      return false; // out of bounces — treat as impact
    }
    const e = 0.5;
    const x = h.hitPoint.x, z = h.hitPoint.z;
    _tNormal.set(
      -(terrain.getHeight(x + e, z) - terrain.getHeight(x - e, z)) / (2 * e),
      1,
      -(terrain.getHeight(x, z + e) - terrain.getHeight(x, z - e)) / (2 * e)
    ).normalize();

    const vn = h.vel.dot(_tNormal);
    // hitPoint is already the center AT the collision plane (radius above
    // the surface for bouncers) — depenetration just needs a small normal
    // clearance so the next sweep doesn't instantly retrigger on slopes.
    const depenetrate = h.config.terrainOffset + 0.05;
    // Grazing/resting contact: armed shells detonate; unarmed (mortar
    // pre-arm) shells bleed off the normal component and slide until the
    // fuse arms them — the T2 mortar bounces off dirt before it can pop.
    if (vn >= -2) {
      if (h.armed) return false;
      h.vel.addScaledVector(_tNormal, -vn);
      h.pos.copy(h.hitPoint).addScaledVector(_tNormal, depenetrate);
      h.prevPos.copy(h.pos);
      if (h.config.bounceSfx) sfx.at(h.pos, h.config.bounceSfx, 0.5, 1.4, h.vel);
      return true;
    }
    h.vel.addScaledVector(_tNormal, -(1 + (h.config.bounceRestitution ?? 0.5)) * vn);
    const fr = h.config.bounceFriction ?? 0.7;
    h.vel.x *= fr;
    h.vel.z *= fr;
    // Sit just above the surface so the next sweep doesn't immediately retrigger
    h.pos.copy(h.hitPoint).addScaledVector(_tNormal, depenetrate);
    h.prevPos.copy(h.pos);
    if (h.config.bounceSfx) {
      // Harder hits ping louder; weak grazes stay quiet — sells mass.
      const gain = Math.min(1, -vn / 40);
      sfx.at(h.pos, `ricochet${1 + Math.floor(Math.random() * 3)}`, gain, 1, h.vel);
    }
    return true;
  }

  private checkBalls(balls?: Targetable[]): boolean {
    const h = this.h;
    if (!balls) return false;
    for (const ball of balls) {
      if (ball.dead) continue;
      if (sweepBall(h, ball)) {
        this.recordHit(h.minHitDist - ball.radius);
        h.hitBall = ball;
        if (h.config.sticks) {
          // Glued to a live victim — it rides the target at the contact
          // offset until the fuse pops it on top of them.
          h.stickAt(h.hitPoint, ball);
          return true;
        }
        h.explode();
        return true;
      }
    }
    return false;
  }

  private checkPlayers(remotePlayers?: Map<string, THREE.Vector3>, playerClasses?: Map<string, string>): boolean {
    const h = this.h;
    if (h.sweepLocal) {
      const lp = h.sweepLocal();
      if (lp && sweepPlayer(h, lp, 'local', h.localClass?.())) {
        this.recordHit(h.minHitDist - classCapsule(h.localClass?.()).radius);
        h.hitPlayerId = 'local';
        if (h.config.sticks) {
          h.stickAt(h.hitPoint, undefined, 'local', remotePlayers);
          return true;
        }
        h.explode();
        return true;
      }
    }
    if (!remotePlayers) return false;
    for (const [playerId, playerPos] of remotePlayers) {
      if (sweepPlayer(h, playerPos, playerId, playerClasses?.get(playerId))) {
        this.recordHit(h.minHitDist - classCapsule(playerClasses?.get(playerId)).radius);
        h.hitPlayerId = playerId;
        if (h.config.sticks) {
          h.stickAt(h.hitPoint, undefined, playerId, remotePlayers);
          return true;
        }
        h.explode();
        return true;
      }
    }
    return false;
  }

  private recordHit(minDist: number): void {
    const h = this.h;
    h.hitAccuracy = Math.max(0, minDist);
    h.hitAge = h.age - h.lastDt * (1 - h.hitT);
    const dx = h.hitX - h.shotOrigin.x;
    const dy = h.hitY - h.shotOrigin.y;
    const dz = h.hitZ - h.shotOrigin.z;
    h.hitDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
