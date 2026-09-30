import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  CRAWLER_RADIUS, CRAWLER_HEALTH,
  CRAWLER_AGGRO_DIST, CRAWLER_POUNCE_DIST, CRAWLER_WINDUP,
  CRAWLER_HOP_SPEED, CRAWLER_HOP_UP, CRAWLER_POUNCE_SPEED,
  CRAWLER_STUN,
  EMERGE_DUR, MELEE_FAVOR,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import { type SimCrawler, makeSimCrawler, stepCrawler } from '../../../shared/creatureSim.js';
import { bindNetSim, applyNetEdgeSim, updateNetSim, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots } from './swarms.js';
import type { SwarmSlotOwner } from './swarm.js';
import { writeCrawlerInstances } from './crawlerVisual.js';
export { crawlerParts } from './crawlerVisual.js';

const _dir = new THREE.Vector3();



/**
 * Ground-hugging target: hops along the terrain in short ballistic arcs,
 * wanders until the player is close, then chases and pounces.
 * Renders into the shared crawler swarm — owns no meshes.
 */
export class Crawler implements Targetable, SwarmSlotOwner {
  id: number; // bindNet re-stamps into the net id namespace post-construction
  readonly variant = 0;
  readonly uber: boolean;

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  maxHealth: number;
  radius: number;
  color = new THREE.Color(0x8a2f22);
  readonly debrisKind = 'goo' as const; // chitin splat, not rock chunks
  readonly dieCue = 'splat' as const;
  scale: number;

  swarmSlot = -1;
  shadowSlot = -1;
  // Public flat fields — crawlerVisual.ts's writeCrawlerInstances reads them
  // through the CrawlerVisHost interface.
  hasSlots = false;
  animT = Math.random() * 10;
  yaw = 0; // net replay writes this from the sim
  squash = 1; // 1 = normal, <1 crouched (windup telegraph)
  glow = 0;   // emissive heat 0..1 — instanceColor >1 fakes the ramp
  flash = 0;  // damage white-flash decay

  state: 'wander' | 'chase' | 'windup' = 'wander';
  private hopTimer = 0;
  private windupTimer = 0;
  private stunTimer = 0;
  private wanderYaw = Math.random() * Math.PI * 2;
  airborne = true; // net replay writes this from the sim
  private pounceAirborne = false;
  // Burrow-in state (set by spawn) — slides up out of the ground on emerge
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;

  /** netDriven = server-authoritative replay: the shared sim runs the
   *  hop stream, crawlEvt edges snap state. TakeDamage sends a claim
   *  instead of trusting local health. */
  netDriven = false;
  netId = 0;
  sim: SimCrawler | null = null;
  netAcc = 0;
  static hitClaim: ((netId: number, damage: number) => void) | null = null;

  /** Server-owned crawler: seed the shared sim from the wire state so the
   *  hop replay (RNG stream included) matches every other client. */
  bindNet(b: NetBindArgs): void {
    this.netDriven = true;
    this.netId = b.id;
    this.id = 0x50000000 + b.id; // net namespace — can't collide with local targetIds
    bindNetSim(this, makeSimCrawler, b);
  }

  /** A wire edge — apply the committed state the authority stepped into. */
  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeSim(this, m);
    if (this.sim) this.state = this.sim.state;
  }

  onPounceHit?: (crawler: Crawler) => void;
  onLanded?: (pos: THREE.Vector3) => void;
  // Uber = matriarch: births a scarab every few seconds while she lives —
  // killing her fast IS the counterplay to an infinite brood.
  onBrood?: (crawler: Crawler) => void;
  private broodTimer = 4; // first birth comes quick — announces she's a spawner

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene; // swarm renders through the shared scene — kept in signature
    this.id = nextTargetId();
    this.uber = uber;
    this.health = this.maxHealth = uber ? CRAWLER_HEALTH * 4 : CRAWLER_HEALTH;
    this.radius = uber ? CRAWLER_RADIUS * 2.2 : CRAWLER_RADIUS;
    this.scale = uber ? 1.3 : 0.5;
    if (uber) this.color.set(0x5a1a3a); // brood-purple — the queen reads different
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();
    this.hasSlots = allocSlots('crawler', this);
    if (!this.hasSlots) this.dead = true; // swarm full — refuse to exist
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.netDriven && this.sim) {
      this.updateNet(dt, terrain);
      return;
    }
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flash > 0) this.flash -= dt;
    if (this.glow > 0 && this.state !== 'windup') this.glow -= dt * 2.5;

    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const distSq = dx * dx + dz * dz;

    if (this.emergeT > 0) {
      // Burrow-in: rise out of the dirt, ease-out — AI stays asleep until surfaced
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + this.radius - this.emergeDepth * (1 - k * k);
      this.animT += dt;
      this.writeInstances(terrain);
      return;
    }

    // Matriarch brood: a scarab crawls out every few seconds while she's
    // alive and on the ground — airtime (knockback) pauses the womb.
    if (this.uber && !this.airborne) {
      this.broodTimer -= dt;
      if (this.broodTimer <= 0) {
        this.broodTimer = 6 + Math.random() * 2;
        this.onBrood?.(this);
      }
    }

    this.stepBody(dt, terrain, playerPos, distSq);
    this.faceTarget(dx, dz, distSq);

    this.animT += dt;
    this.writeInstances(terrain);
  }

  /** Ballistic hop integration + ground contact (pounce landing resolves
   *  here — air hit and ground hit are different radii). */
  private stepBody(dt: number, terrain: Terrain, playerPos: THREE.Vector3, distSq: number): void {
    this.vel.y += GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);

    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y - this.radius <= gy) {
      this.pos.y = gy + this.radius;
      if (this.airborne) this.onLanded?.(this.pos);
      this.airborne = false;
      this.vel.set(0, 0, 0);
      if (this.pounceAirborne) {
        this.pounceAirborne = false;
        if (this.pos.distanceToSquared(playerPos) < 6.25 * MELEE_FAVOR * MELEE_FAVOR) this.onPounceHit?.(this);
      }
      this.groundThink(dt, terrain, playerPos, distSq);
    } else {
      this.airborne = true;
      if (this.pounceAirborne && this.pos.distanceToSquared(playerPos) < 4 * MELEE_FAVOR * MELEE_FAVOR) {
        this.pounceAirborne = false;
        this.onPounceHit?.(this);
      }
    }
  }

  private faceTarget(dx: number, dz: number, distSq: number): void {
    if (this.state === 'windup' && distSq > 0.01) {
      this.yaw = Math.atan2(dx, dz);
    } else if (this.vel.lengthSq() > 1) {
      this.yaw = Math.atan2(this.vel.x, this.vel.z);
    }
  }

  writeInstances(terrain: Terrain): void {
    writeCrawlerInstances(this, terrain);
  }

  private groundThink(dt: number, terrain: Terrain, playerPos: THREE.Vector3, distSq: number): void {
    if (this.stunTimer > 0) return;

    if (this.state === 'windup') {
      this.windupTimer -= dt;
      const t = 1 - this.windupTimer / CRAWLER_WINDUP;
      this.squash = 1 - t * 0.4;
      this.glow = t * 0.6;
      if (this.windupTimer <= 0) {
        this.squash = 1;
        this.pounce(playerPos);
      }
      return;
    }

    if (distSq < CRAWLER_POUNCE_DIST * CRAWLER_POUNCE_DIST) {
      this.state = 'windup';
      this.windupTimer = CRAWLER_WINDUP;
      return;
    }

    this.hopTimer -= dt;
    if (this.hopTimer > 0) return;
    this.hopTimer = 0.25 + Math.random() * 0.3;

    if (distSq < CRAWLER_AGGRO_DIST * CRAWLER_AGGRO_DIST) {
      this.state = 'chase';
      const d = Math.sqrt(distSq) || 0.001;
      this.vel.set(
        ((playerPos.x - this.pos.x) / d) * CRAWLER_HOP_SPEED,
        CRAWLER_HOP_UP,
        ((playerPos.z - this.pos.z) / d) * CRAWLER_HOP_SPEED,
      );
    } else {
      this.state = 'wander';
      if (Math.random() < 0.4) this.wanderYaw += (Math.random() - 0.5) * 2;
      this.vel.set(
        Math.sin(this.wanderYaw) * CRAWLER_HOP_SPEED * 0.35,
        CRAWLER_HOP_UP * 0.8,
        Math.cos(this.wanderYaw) * CRAWLER_HOP_SPEED * 0.35,
      );
    }
  }

  private pounce(playerPos: THREE.Vector3): void {
    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const pd = Math.sqrt(dx * dx + dz * dz) || 0.001;
    const hSpeed = CRAWLER_POUNCE_SPEED;
    const t = Math.max(0.15, pd / hSpeed);
    const vy = (playerPos.y - this.pos.y + 0.5 * Math.abs(GRAVITY) * t * t) / t;
    this.vel.set((dx / pd) * hSpeed, vy, (dz / pd) * hSpeed);
    this.airborne = true;
    this.pounceAirborne = true;
    this.state = 'chase';
    this.glow = 0.6;
  }

  /** netDriven leg — the shared replay writes pos/vel/yaw/health; the
   *  crawler-only telegraphs (windup squash/glow) sit on top. */
  private updateNet(dt: number, terrain: Terrain): void {
    const s = this.sim!;
    updateNetSim(this, dt, terrain, stepCrawler, { grounded: true });
    this.state = s.state;
    if (s.state === 'windup') {
      const t = 1 - s.windupTimer / CRAWLER_WINDUP;
      this.squash = 1 - Math.max(0, t) * 0.4;
      this.glow = Math.max(0, t) * 0.6;
    } else {
      this.squash = 1;
      if (this.glow > 0) this.glow -= dt * 2.5;
    }
    if (this.flash > 0) this.flash -= dt;
    this.animT += dt;
    this.writeInstances(terrain);
  }

  takeDamage(damage: number): boolean {
    if (this.netDriven) {
      this.flash = 0.15;
      return claimDamageMelee(this, damage, Crawler.hitClaim);
    }
    this.health -= damage;
    this.flash = 0.15;
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force);
    this.stunTimer = CRAWLER_STUN;
    if (this.state === 'windup') {
      this.state = 'chase';
      this.squash = 1;
      this.glow = 0;
    }
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force);
    this.stunTimer = CRAWLER_STUN;
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('crawler', this);
      this.hasSlots = false;
    }
  }
}
