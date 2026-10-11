import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  SEEKER_RADIUS, SEEKER_HEALTH,
  SEEKER_AGGRO_DIST, SEEKER_HOVER, SEEKER_SPEED, SEEKER_ACCEL,
  SEEKER_DART_RANGE, SEEKER_DART_SPEED, SEEKER_DART_TELEGRAPH, SEEKER_DART_MAX,
  SEEKER_STING_DIST, SEEKER_RECOVER, SEEKER_STUN, MELEE_FAVOR,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots } from './swarms.js';
import type { SwarmSlotOwner } from './swarm.js';
import { writeSeekerInstances } from './seekerVisual.js';
export { seekerParts } from './seekerVisual.js';

const _dir = new THREE.Vector3();
const _scratch = new THREE.Vector3();

type SeekerState = 'patrol' | 'chase' | 'telegraph' | 'dart' | 'recover';
interface SeekerCtx { dt: number; distSq: number; playerPos: THREE.Vector3; playerVel?: THREE.Vector3 }


/**
 * Airborne sting enemy — the anti-"fly in a straight line" teacher.
 * Renders into the shared seeker swarm — owns no meshes.
 */
export class Seeker implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0xCF_C3_9A); // bone-pale chitin
  readonly debrisKind = 'goo' as const;
  readonly ichor = 0x86_C8_E8; // pale blue, matches the bone chitin
  scale = 0.3;

  swarmSlot = -1;
  shadowSlot = -1;
  // Public flat fields — seekerVisual.ts's writeSeekerInstances reads them
  // through the SeekerVisHost interface.
  hasSlots = false;

  animT = Math.random() * 10;
  yaw = 0;
  pitch = 0;
  roll = 0;
  eyeScale = 0.55;
  glow = 0;
  flash = 0;

  state: SeekerState = 'patrol';
  private telegraphTimer = 0;
  private dartTimer = 0;
  private recoverTimer = 0;
  private stunTimer = 0;
  private dartDir = new THREE.Vector3();
  private bobPhase = Math.random() * Math.PI * 2;

  onSting?: (seeker: Seeker) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    // Uber = "lancer": bigger, tankier, and it LEADS the dart — telegraph
    // locks onto pos + vel × flight time, so holding a strafe line into
    // the dart gets you stung. Juke during the telegraph.
    this.uber = uber;
    this.health = this.maxHealth = uber ? SEEKER_HEALTH * 3 : SEEKER_HEALTH;
    this.radius = uber ? SEEKER_RADIUS * 1.8 : SEEKER_RADIUS;
    if (uber) {this.color.set(0x9A_2A_2A);} // blood lancer
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + SEEKER_HOVER;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('seeker', this);
    if (!this.hasSlots) {this.dead = true;}
  }

  // State handlers live in a static table — each is a small (self, ctx)
  // function, so no per-instance closures or switch boilerplate. Adding a
  // behavior is a table entry, not another case in a 100-line update.
  // Reused scratch — update runs per frame per seeker, no allocation wanted
  private static readonly _ctx: SeekerCtx = { dt: 0, distSq: 0, playerPos: null as never };

  private static readonly STATES: Record<SeekerState, (s: Seeker, c: SeekerCtx) => void> = {
    patrol(s, c) {
      _dir.subVectors(c.playerPos, s.pos);
      const d = _dir.length() || 0.001;
      _dir.multiplyScalar(1 / d);
      const hold = SEEKER_AGGRO_DIST * 0.8;
      const pull = Math.max(-1, Math.min(1, (d - hold) / hold));
      s.vel.addScaledVector(_dir, pull * SEEKER_ACCEL * 0.4 * c.dt);
      s.capSpeed(SEEKER_SPEED * 0.4);
      if (c.distSq < SEEKER_AGGRO_DIST * SEEKER_AGGRO_DIST) {s.state = 'chase';}
      s.glow = 0;
    },
    chase(s, c) {
      if (c.distSq > SEEKER_AGGRO_DIST * SEEKER_AGGRO_DIST * 1.4) { s.state = 'patrol'; return; }
      _dir.subVectors(c.playerPos, s.pos);
      const d = _dir.length() || 0.001;
      _dir.multiplyScalar(1 / d);
      s.vel.addScaledVector(_dir, SEEKER_ACCEL * c.dt);
      s.capSpeed(SEEKER_SPEED);
      s.glow = 0.2;
      if (d < SEEKER_DART_RANGE && s.stunTimer <= 0) {
        s.state = 'telegraph';
        s.telegraphTimer = SEEKER_DART_TELEGRAPH;
        s.dartDir.copy(_dir);
      }
    },
    telegraph(s, c) {
      s.telegraphTimer -= c.dt;
      s.vel.multiplyScalar(1 - 4 * c.dt);
      _dir.subVectors(c.playerPos, s.pos);
      if (s.uber && c.playerVel) {
        // Predictive lock: aim where you'll BE when the dart lands —
        // flight ≈ dist / dartSpeed, capped so orbiters don't overshoot
        const d = _dir.length() || 0.001;
        _dir.addScaledVector(c.playerVel, Math.min(0.6, d / SEEKER_DART_SPEED));
      }
      _dir.normalize();
      s.dartDir.lerp(_dir, 6 * c.dt).normalize();
      const t = 1 - s.telegraphTimer / SEEKER_DART_TELEGRAPH;
      s.glow = 0.7 * t;
      s.eyeScale = 0.9 + t * 0.8;
      s.vel.addScaledVector(s.dartDir, -6 * c.dt);
      if (s.telegraphTimer <= 0) {
        s.state = 'dart';
        s.dartTimer = SEEKER_DART_MAX;
        s.vel.copy(s.dartDir).multiplyScalar(SEEKER_DART_SPEED);
        s.glow = 0.8;
      }
    },
    dart(s, c) {
      s.dartTimer -= c.dt;
      if (s.dartTimer <= 0) {s.beginRecover();}
    },
    recover(s, c) {
      s.recoverTimer -= c.dt;
      _dir.subVectors(s.pos, c.playerPos);
      _dir.y = 0.8;
      s.vel.addScaledVector(_dir.normalize(), SEEKER_ACCEL * 0.5 * c.dt);
      s.capSpeed(SEEKER_SPEED * 0.6);
      s.glow = 0;
      if (s.recoverTimer <= 0) {s.state = 'chase';}
    },
  };

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.stunTimer > 0) {this.stunTimer -= dt;}
    if (this.flash > 0) {this.flash -= dt;}

    this.animT += dt;
    const distSq = this.pos.distanceToSquared(playerPos);

    const ctx = Seeker._ctx;
    ctx.dt = dt; ctx.distSq = distSq; ctx.playerPos = playerPos; ctx.playerVel = playerVel;
    Seeker.STATES[this.state](this, ctx);

    const stingD = SEEKER_STING_DIST * MELEE_FAVOR;
    if ((this.state === 'dart' || this.state === 'chase') && distSq < stingD * stingD) {
      this.onSting?.(this);
      this.beginRecover();
    }

    this.pos.addScaledVector(this.vel, dt);
    this.settle(dt, terrain);
    this.writeInstances();
  }

  // Post-move settle: floor clamp + patrol hover, then face travel
  // direction and bank into turns.
  private settle(dt: number, terrain: Terrain): void {
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    const bob = Math.sin(this.animT * 3 + this.bobPhase) * 0.6;
    const minY = gy + (this.state === 'dart' ? 0.8 : 1.2);
    if (this.pos.y < minY) { this.pos.y = minY; if (this.vel.y < 0) {this.vel.y = 0;} }
    if (this.state === 'patrol') {
      const targetY = gy + SEEKER_HOVER + bob;
      this.pos.y += (targetY - this.pos.y) * Math.min(1, 2 * dt);
    }

    if (this.vel.lengthSq() > 1) {
      this.yaw = Math.atan2(this.vel.x, this.vel.z);
      this.pitch = THREE.MathUtils.clamp(-this.vel.y * 0.04, -0.6, 0.6);
      this.roll = THREE.MathUtils.clamp(
        -(this.vel.x * Math.cos(this.yaw) - this.vel.z * Math.sin(this.yaw)) * 0.03, -0.5, 0.5);
    }

    if (this.state !== 'telegraph' && this.state !== 'dart') {
      this.eyeScale = (this.state === 'chase' ? 0.75 : 0.55) + 0.15 * Math.sin(this.animT * 5);
    }
  }

  private writeInstances(): void {
    writeSeekerInstances(this);
  }

  private beginRecover(): void {
    this.state = 'recover';
    this.recoverTimer = SEEKER_RECOVER;
    this.glow = 0;
    this.vel.y += 6; // sting momentum carries through, not a dead stop
  }

  private capSpeed(max: number): void {
    const s = this.vel.length();
    if (s > max) {this.vel.multiplyScalar(max / s);}
  }

  takeDamage(damage: number): boolean {
    this.health -= damage;
    this.flash = 0.15;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _scratch.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_scratch, force * 1.5); // light body — blasts send it tumbling
    this.stunTimer = SEEKER_STUN;
    if (this.state === 'telegraph' || this.state === 'dart') {
      this.beginRecover(); // a blast interrupts the attack
    }
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _scratch.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_scratch, force * 1.5);
    this.stunTimer = SEEKER_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('seeker', this);
      this.hasSlots = false;
    }
  }
}
