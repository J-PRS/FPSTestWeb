import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  MINE_RADIUS, MINE_ARM_TIME, MINE_TRIGGER_DIST, MINE_LIFE,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { allocSlots, freeSlots, getSwarm } from './swarms.js';
import type { SwarmPart, SwarmSlotOwner } from './swarm.js';

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
    color: 0xff5522, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return [
    { geometry: _domeGeo, material: _domeMat },
    { geometry: _glowGeo, material: _glowMat },
  ];
}

/**
 * Proximity mine planted by Miners. Blink quickens as the player closes in.
 * Shootable — a killed mine detonates. Renders into the shared mine swarm.
 */
export class Mine implements Targetable, SwarmSlotOwner {
  readonly id: number;
  readonly variant = 0;

  pos: THREE.Vector3;
  vel = new THREE.Vector3(); // mines don't move — knockback would be weird
  dead = false;
  health = 1;
  maxHealth = 1;
  radius = MINE_RADIUS;
  color = new THREE.Color(0x3a2a1a); // dark shell, glow does the talking
  scale = 0.2;

  swarmSlot = -1;
  shadowSlot = -1; // mines hug the ground — the dome is its own grounding cue
  private hasSlots = false;

  private age = 0;
  private blinkPhase = Math.random() * Math.PI * 2;
  private glowPulse = 0;

  onDetonate?: (mine: Mine) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    void scene;
    this.id = nextTargetId();
    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius * 0.55;
    this.hasSlots = allocSlots('mine', this);
    if (!this.hasSlots) this.dead = true;
  }

  get armed(): boolean { return this.age >= MINE_ARM_TIME; }

  update(dt: number, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    this.age += dt;

    const distSq = this.pos.distanceToSquared(playerPos);
    const dist = Math.sqrt(distSq);

    if (this.armed && dist < MINE_TRIGGER_DIST) { this.detonate(); return; }
    if (this.age > MINE_LIFE) { this.detonate(); return; }

    // Blink rate accelerates as the player approaches — the audible-beep
    // equivalent in pure visuals. Unarmed mines blink slow and dim.
    const urgency = 1 - Math.min(1, dist / (MINE_TRIGGER_DIST * 4));
    const rate = this.armed ? 3 + urgency * 10 : 1.5;
    const p = (Math.sin(this.age * rate * Math.PI * 2 + this.blinkPhase) + 1) / 2;
    const bright = this.armed ? 0.4 + p * (0.4 + urgency * 0.5) : 0.25 + p * 0.15;
    this.glowPulse = bright;

    if (!this.hasSlots) return;
    const swarm = getSwarm('mine');
    if (!swarm) return;
    const slot = this.swarmSlot;
    const r = this.radius;

    _root.compose(this.pos, _q.identity(), _s.setScalar(r));
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

  private detonate(): void {
    if (this.dead) return;
    this.dead = true;
    this.onDetonate?.(this);
  }

  takeDamage(): boolean {
    // Shot mines detonate — clearing a field by shooting it is the counterplay
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
