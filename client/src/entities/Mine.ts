import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  MINE_RADIUS, MINE_ARM_TIME, MINE_TRIGGER_DIST, MINE_LIFE, MINE_BLAST_RADIUS,
  EMERGE_DUR,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';
import { getGlowTexture } from '../effects/glowTexture.js';

const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

const PART_DOME = 0;
const PART_GLOW = 1; // warning glow quad on the dome top

const _domeGeo = (() => {
  const g = new THREE.IcosahedronGeometry(1, 1);
  g.scale(1.0, 0.55, 1.0);
  return g;
})();
const _glowGeo = new THREE.PlaneGeometry(1, 1);

let _domeMat: THREE.MeshLambertMaterial | null = null;
let _glowMat: THREE.MeshBasicMaterial | null = null;

export function mineParts(): SwarmPart[] {
  if (!_domeMat) _domeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (!_glowMat) _glowMat = new THREE.MeshBasicMaterial({
    map: getGlowTexture(), color: 0xff5522, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: _domeGeo, material: _domeMat },
    { geometry: _glowGeo, material: _glowMat },
  ];
}

/**
 * Proximity mine planted by Overlords. Blink quickens as the player closes in.
 * Shootable — a killed mine detonates. Renders into the shared mine swarm.
 */
export class Mine implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  readonly uber: boolean;
  /** Blast envelope — entities reads this so a doombloom detonates bigger. */
  readonly blastRadius: number;

  pos: THREE.Vector3;
  vel = new THREE.Vector3(); // mines don't move — knockback would be weird
  dead = false;
  health = 1;
  maxHealth = 1;
  // Repair-tool armor lets a planted field survive stray chip damage —
  // soak ticks down before the shell itself gets touched.
  armor = 0;
  radius: number;
  color = new THREE.Color(0x3a2a1a); // dark shell, glow does the talking
  scale = 0.2;

  swarmSlot = -1;
  shadowSlot = -1; // mines hug the ground — the dome is its own grounding cue
  private hasSlots = false;

  private age = 0;
  // Burrow-in state (set by spawn) — the dome slides up out of the ground
  emergeT = 0;
  emergeDepth = 0;
  emergeRestY = 0;
  private blinkPhase = Math.random() * Math.PI * 2;
  private glowPulse = 0;
  // Slope tilt — mines don't move, so the ground-normal alignment is a
  // one-time compute in the constructor; a dome planted on a hillside
  // hugs the slope instead of floating on the downhill edge.
  private tilt = new THREE.Quaternion();

  onDetonate?: (mine: Mine) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3, uber = false) {
    void scene;
    this.id = nextTargetId();
    // Uber = "doombloom": a bigger pod with a bigger payload — twice the
    // blast envelope, and it triggers from further out.
    this.uber = uber;
    this.radius = uber ? MINE_RADIUS * 1.7 : MINE_RADIUS;
    this.blastRadius = uber ? MINE_BLAST_RADIUS * 2 : MINE_BLAST_RADIUS;
    this.scale = uber ? 0.4 : 0.2;
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius * 0.55;
    this.tilt.setFromUnitVectors(new THREE.Vector3(0, 1, 0), terrain.getNormal(pos.x, pos.z));
    this.hasSlots = allocSlots('mine', this);
    if (!this.hasSlots) this.dead = true;
  }

  get armed(): boolean { return this.age >= MINE_ARM_TIME; }

  update(dt: number, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    this.age += dt;

    if (this.emergeT > 0) {
      // Burrow-in: the dome slides up out of the dirt, ease-out
      this.emergeT -= dt;
      const k = 1 - Math.max(0, this.emergeT) / EMERGE_DUR;
      this.pos.y = this.emergeRestY - this.emergeDepth * (1 - k * k);
    }

    const distSq = this.pos.distanceToSquared(playerPos);
    const dist = Math.sqrt(distSq);

    const trig = this.uber ? MINE_TRIGGER_DIST * 1.5 : MINE_TRIGGER_DIST;
    if (this.armed && dist < trig) { this.detonate(); return; }
    if (this.age > MINE_LIFE) { this.detonate(); return; }

    // Blink rate accelerates as the player approaches — the audible-beep
    // equivalent in pure visuals. Unarmed mines blink slow and dim.
    const urgency = 1 - Math.min(1, dist / (trig * 4));
    const rate = this.armed ? 3 + urgency * 10 : 1.5;
    const p = (Math.sin(this.age * rate * Math.PI * 2 + this.blinkPhase) + 1) / 2;
    const bright = this.armed ? 0.4 + p * (0.4 + urgency * 0.5) : 0.25 + p * 0.15;
    this.glowPulse = bright;

    if (!this.hasSlots) return;
    const swarm = getSwarm('mine');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;

    _root.compose(this.pos, this.tilt, _s.setScalar(r));
    swarm.setMatrix(PART_DOME, slot, _root);
    // instanceColor carries the emissive blink — dome brightens orange-hot
    swarm.setColor(PART_DOME, slot,
      this.color.r + bright, this.color.g + bright * 0.25, this.color.b);

    // Warning glow quad on the dome top — pulse scales with urgency
    const gs = 1.3 + p * 0.4;
    _local.compose(_p.set(0, 0.9, 0), _q.identity(), _s.setScalar(gs));
    _world.multiplyMatrices(_root, _local);
    swarm.setMatrix(PART_GLOW, slot, _world);
    const go = this.armed ? 0.5 + p * 0.5 : 0.35;
    swarm.setColor(PART_GLOW, slot, go, go, go);
  }

  /** Re-seat on terrain after a ballistic landing (thrown pack mines) —
   *  re-aligns the dome to the slope under its new resting spot. */
  seatOn(terrain: Terrain): void {
    this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + this.radius * 0.55;
    this.tilt.setFromUnitVectors(new THREE.Vector3(0, 1, 0), terrain.getNormal(this.pos.x, this.pos.z));
  }

  private detonate(): void {
    if (this.dead) return;
    this.dead = true;
    this.onDetonate?.(this);
  }

  heal(n: number): void {
    this.armor = Math.min(this.maxHealth * 2, this.armor + n);
  }

  takeDamage(): boolean {
    // Any damage detonates — clearing a field by shooting it is the counterplay.
    // Repair armor soaks the first hits, so an armored mine eats a few shots.
    if (this.armor > 0) { this.armor -= 1; return false; }
    this.detonate();
    return true;
  }

  applyKnockback(): void { /* mines are bolted down */ }
  applyPull(): void { /* ditto */ }

  dispose(): void {
    if (this.hasSlots) {
      freeSlots('mine', this);
      this.hasSlots = false;
    }
  }
}
