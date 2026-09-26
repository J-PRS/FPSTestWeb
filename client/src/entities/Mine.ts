import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  MINE_RADIUS, MINE_ARM_TIME, MINE_TRIGGER_DIST, MINE_LIFE,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';

// Shared dome geometry — a squashed half-buried mine
let _geo: THREE.IcosahedronGeometry | null = null;
function getGeo(): THREE.IcosahedronGeometry {
  if (!_geo) {
    _geo = new THREE.IcosahedronGeometry(1, 1);
    _geo.scale(1.0, 0.55, 1.0);
  }
  return _geo;
}

/**
 * Proximity mine planted by Miners. Sits flush on the terrain, pulses a
 * warning glow that quickens as the player closes in. Shootable — a killed
 * mine detonates (harmlessly at range, nastily up close). The mine calls
 * onDetonate once; entities.ts decides how hard it hits.
 */
export class Mine implements Targetable {
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

  private mesh: THREE.Mesh;
  private mat: THREE.MeshLambertMaterial;
  private glow: THREE.Sprite;
  private glowMat: THREE.SpriteMaterial;
  private scene: THREE.Scene;
  private age = 0;
  private blinkPhase = Math.random() * Math.PI * 2;

  /** Fired once when the mine blows (proximity, shot, or expiry). */
  onDetonate?: (mine: Mine) => void;

  get disposed(): boolean { return this.dead; }

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this.id = nextTargetId();

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius * 0.55;

    this.mat = new THREE.MeshLambertMaterial({ color: this.color, emissive: 0x000000 });
    this.mesh = new THREE.Mesh(getGeo(), this.mat);
    this.mesh.scale.setScalar(this.radius);
    this.mesh.position.copy(this.pos);
    scene.add(this.mesh);

    // Warning glow — sits on the dome top, pulses with proximity
    this.glowMat = new THREE.SpriteMaterial({ map: getGlowTex(), color: 0xff5522, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.position.set(0, 0.9, 0);
    this.glow.scale.setScalar(this.radius * 1.4);
    this.mesh.add(this.glow);
  }

  get armed(): boolean { return this.age >= MINE_ARM_TIME; }

  update(dt: number, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    this.age += dt;

    const distSq = this.pos.distanceToSquared(playerPos);
    const dist = Math.sqrt(distSq);

    if (this.armed && dist < MINE_TRIGGER_DIST) { this.detonate(); return; }
    if (this.age > MINE_LIFE) { this.detonate(); return; } // fizzle-pop on expiry

    // Blink rate accelerates as the player approaches — the audible-beep
    // equivalent in pure visuals. Unarmed mines blink slow and dim.
    const urgency = 1 - Math.min(1, dist / (MINE_TRIGGER_DIST * 4));
    const rate = this.armed ? 3 + urgency * 10 : 1.5;
    const p = (Math.sin(this.age * rate * Math.PI * 2 + this.blinkPhase) + 1) / 2;
    const bright = this.armed ? 0.4 + p * (0.4 + urgency * 0.5) : 0.25 + p * 0.15;
    this.mat.emissive.setRGB(bright, bright * 0.25, 0);
    this.glowMat.opacity = this.armed ? 0.5 + p * 0.5 : 0.35;
    this.glow.scale.setScalar(this.radius * (1.3 + p * 0.4));
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
    this.scene.remove(this.mesh);
    this.mat.dispose();
    this.glowMat.dispose();
    // geometry + glow texture are shared — never dispose
  }
}

let _glowTex: THREE.Texture | null = null;
function getGlowTex(): THREE.Texture {
  if (!_glowTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    _glowTex = new THREE.CanvasTexture(c);
  }
  return _glowTex;
}
