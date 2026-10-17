import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  CRAWLER_RADIUS, CRAWLER_WINDUP,
  EMERGE_DUR,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import { type SimCrawler, makeSimCrawler, stepCrawler, applyCrawlerDamage, commitTarget } from '../../../shared/creatureSim.js';
import { bindNetSim, applyNetEdgeSim, updateNetSim, updateLocalSim, claimDamageMelee, type NetBindArgs } from '../game/netMelee.js';
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
  color = new THREE.Color(0x8A_2F_22);
  readonly debrisKind = 'goo' as const; // chitin splat, not rock chunks
  readonly dieCue = 'splat' as const;
  readonly ichor = 0x3F_C9_B0; // teal pops hard against the red shell
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
  airborne = true; // mirrors sim flight — hop arcs land on their own clock
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
    this.id = 0x50_00_00_00 + b.id; // net namespace — can't collide with local targetIds
    bindNetSim(this, makeSimCrawler, b);
  }

  /** A wire edge — apply the committed state the authority stepped into. */
  applyNetEdge(m: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; kind: string; targetId: string | null; tp?: { x: number; y: number; z: number } | null }): void {
    applyNetEdgeSim(this, m);
    if (this.sim) {this.state = this.sim.state;}
  }

  onPounceHit?: (crawler: Crawler) => void;
  onLanded?: (pos: THREE.Vector3) => void;
  // Uber = matriarch: births a scarab every few seconds while she lives —
  // killing her fast IS the counterplay to an infinite brood.
  onBrood?: (crawler: Crawler) => void;
  private broodTimer = 4; // first birth comes quick — announces she's a spawner

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    this.id = nextTargetId();
    this.uber = uber;
    this.radius = uber ? CRAWLER_RADIUS * 2.2 : CRAWLER_RADIUS;
    this.scale = uber ? 1.3 : 0.5;
    if (uber) {this.color.set(0x5A_1A_3A);} // brood-purple — the queen reads different
    this.pos = pos.clone();
    const sg = terrain.getHeight(pos.x, pos.z);
    if (Number.isFinite(sg)) {this.pos.y = sg + this.radius;}
    this.vel = new THREE.Vector3();
    // Local authority: the same shared sim the wire replays — health and
    // AI clocks live there, never a second copy. bindNet overwrites it
    // when a server creature owns the id instead.
    this.sim = makeSimCrawler(this.id, { x: this.pos.x, y: this.pos.y, z: this.pos.z }, uber, this.id, 'crawler');
    this.health = this.sim.health;
    this.maxHealth = this.sim.maxHealth;
    this.hasSlots = allocSlots('crawler', this);
    if (!this.hasSlots) {this.dead = true;} // swarm full — refuse to exist
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {return;}
    if (this.netDriven && this.sim) {
      this.updateNet(dt, terrain);
      return;
    }
    if (this.flash > 0) {this.flash -= dt;}
    const s = this.sim;

    if (this.emergeT > 0) {
      // Burrow-in: rise out of the dirt, ease-out — AI stays asleep until surfaced
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      const eg = terrain.getHeight(this.pos.x, this.pos.z);
      if (Number.isFinite(eg)) {this.pos.y = eg + this.radius - this.emergeDepth * (1 - k * k);}
      if (s) {s.x = this.pos.x; s.y = this.pos.y; s.z = this.pos.z;}
      this.animT += dt;
      this.writeInstances(terrain);
      return;
    }

    if (s) {
      // Live aim each frame — offline has no link to lag behind. The
      // wire model commits on retarget edges; the local sim commits on
      // every step, the strict-superset cadence.
      commitTarget(s, 'local', playerPos);
      const wasAir = this.airborne;
      const ev = updateLocalSim(this, dt, terrain, stepCrawler, playerPos, { grounded: true });
      this.state = s.state;
      if (wasAir && !this.airborne) {this.onLanded?.(this.pos);}
      if (ev === 'bite') {this.onPounceHit?.(this);}
      if (s.state === 'windup') {
        const t = 1 - s.windupTimer / CRAWLER_WINDUP;
        this.squash = 1 - Math.max(0, t) * 0.4;
        this.glow = Math.max(0, t) * 0.6;
      } else {
        this.squash = 1;
        if (this.glow > 0) {this.glow -= dt * 2.5;}
      }
      if (s.dead) {this.dead = true; return;}
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

    this.animT += dt;
    this.writeInstances(terrain);
  }

  writeInstances(terrain: Terrain): void {
    writeCrawlerInstances(this, terrain);
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
      if (this.glow > 0) {this.glow -= dt * 2.5;}
    }
    if (this.flash > 0) {this.flash -= dt;}
    this.animT += dt;
    this.writeInstances(terrain);
  }

  takeDamage(damage: number, opts?: { serverPaid?: boolean }): boolean {
    if (this.netDriven) {
      this.flash = 0.15;
      return claimDamageMelee(this, damage, Crawler.hitClaim, opts?.serverPaid);
    }
    this.flash = 0.15;
    const s = this.sim;
    if (s) { if (applyCrawlerDamage(s, damage)) { this.dead = true; return true; } }
    else if ((this.health -= damage) <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (!Number.isFinite(from.x + from.y + from.z + force)) {return;}    _dir.copy(this.pos).sub(from).normalize();
    const s = this.sim;
    if (s) {
      s.vx += _dir.x * force; s.vy += _dir.y * force; s.vz += _dir.z * force;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      if (s.state === 'windup') {s.state = 'chase'; this.squash = 1; this.glow = 0;}
      return;
    }
    this.vel.addScaledVector(_dir, force);
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (!Number.isFinite(to.x + to.y + to.z + force)) {return;}    _dir.copy(to).sub(this.pos).normalize();
    const s = this.sim;
    if (s) {
      s.vx += _dir.x * force; s.vy += _dir.y * force; s.vz += _dir.z * force;
      s.stunTimer = Math.max(s.stunTimer, s.sp.STUN_S);
      return;
    }
    this.vel.addScaledVector(_dir, force);
  }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('crawler', this);
      this.hasSlots = false;
    }
  }
}
