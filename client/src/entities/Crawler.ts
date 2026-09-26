import * as THREE from 'three';
import { nextTargetId } from './targetIds.js';

import {
  GRAVITY,
  CRAWLER_RADIUS, CRAWLER_HEALTH,
  CRAWLER_AGGRO_DIST, CRAWLER_POUNCE_DIST, CRAWLER_WINDUP,
  CRAWLER_HOP_SPEED, CRAWLER_HOP_UP, CRAWLER_POUNCE_SPEED,
  CRAWLER_STUN,
} from '../core/config.js';
import { Terrain } from '../world/terrain.js';
import type { Targetable } from './balls.js';
import { BlobShadow } from '../effects/blobShadow.js';

const _dir = new THREE.Vector3();
const _scratch = new THREE.Vector3();

// Shared geometries — body is a squashed icosahedron carapace, head a smaller
// dome up front, legs/fangs are thin cones. All shared across crawlers.
let _geo: THREE.IcosahedronGeometry | null = null;
function getGeo(): THREE.IcosahedronGeometry {
  if (!_geo) {
    _geo = new THREE.IcosahedronGeometry(1, 1);
    _geo.scale(1.0, 0.55, 1.25); // squashed + slightly elongated
  }
  return _geo;
}
let _headGeo: THREE.IcosahedronGeometry | null = null;
function getHeadGeo(): THREE.IcosahedronGeometry {
  if (!_headGeo) {
    _headGeo = new THREE.IcosahedronGeometry(0.45, 1);
    _headGeo.scale(1.1, 0.8, 1.0);
  }
  return _headGeo;
}
let _legGeo: THREE.ConeGeometry | null = null;
function getLegGeo(): THREE.ConeGeometry {
  if (!_legGeo) _legGeo = new THREE.ConeGeometry(0.09, 1.1, 4); // points +y; rotate to splay
  return _legGeo;
}
let _fangGeo: THREE.ConeGeometry | null = null;
function getFangGeo(): THREE.ConeGeometry {
  if (!_fangGeo) _fangGeo = new THREE.ConeGeometry(0.08, 0.4, 4);
  return _fangGeo;
}

/**
 * Ground-hugging target: hops along the terrain in short ballistic arcs,
 * wanders until the player is close, then chases and pounces.
 * The pounce is a solved ballistic arc onto the player (same math as the
 * ball dash) preceded by a windup crouch + glow telegraph.
 */
export class Crawler implements Targetable {
  readonly id: number;
  readonly variant = 0; // Targetable surface — demo treats it like a small ball

  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health = CRAWLER_HEALTH;
  maxHealth = CRAWLER_HEALTH;
  radius = CRAWLER_RADIUS;
  color = new THREE.Color(0x8a2f22); // dried-blood carapace
  scale = 0.5; // nugget count + debris size on death

  private mesh: THREE.Mesh;
  private mat: THREE.MeshLambertMaterial;
  private legs: THREE.Mesh[] = [];
  private eyeL: THREE.Sprite;
  private eyeR: THREE.Sprite;
  private eyeMatL: THREE.SpriteMaterial;
  private eyeMatR: THREE.SpriteMaterial;
  private scene: THREE.Scene;
  private shadow: BlobShadow;
  private animT = Math.random() * 10; // desync leg scuttle between crawlers

  private state: 'wander' | 'chase' | 'windup' = 'wander';
  private hopTimer = 0;      // countdown to next scuttle-hop
  private windupTimer = 0;   // crouch before pounce
  private stunTimer = 0;     // blast knockback suppression
  private flashTimer = 0;
  private glowT = 0;         // pounce-launch emissive flash decay
  private wanderYaw = Math.random() * Math.PI * 2;
  private airborne = true;
  private pounceAirborne = false; // mid-flight after a pounce launch

  /** Called when a pounce lands near the player — wire the shove in main. */
  onPounceHit?: (crawler: Crawler) => void;
  /** Dust puff hook on every ground landing. */
  onLanded?: (pos: THREE.Vector3) => void;

  get disposed(): boolean { return this.dead; } // no trail fade — gone instantly

  constructor(scene: THREE.Scene, terrain: Terrain, pos: THREE.Vector3) {
    this.scene = scene;
    this.id = nextTargetId();

    this.pos = pos.clone();
    this.pos.y = terrain.getHeight(pos.x, pos.z) + this.radius;
    this.vel = new THREE.Vector3();

    this.mat = new THREE.MeshLambertMaterial({ color: this.color, emissive: 0x1a0503 });
    this.mesh = new THREE.Mesh(getGeo(), this.mat);
    this.mesh.scale.setScalar(this.radius);
    this.mesh.position.copy(this.pos);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Head dome up front — carries the eyes and fangs
    const head = new THREE.Mesh(getHeadGeo(), this.mat);
    head.position.set(0, 0.35, 0.85);
    this.mesh.add(head);

    // Six legs splayed down/out — scuttle-animated in update()
    for (let i = 0; i < 3; i++) {
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(getLegGeo(), this.mat);
        leg.position.set(side * 0.85, -0.15, (i - 1) * 0.75);
        leg.rotation.z = side * 2.1;   // cone points down-outward
        leg.rotation.y = side * 0.25;
        this.mesh.add(leg);
        this.legs.push(leg);
      }
    }

    // Fangs at the front of the head
    for (const side of [-1, 1]) {
      const fang = new THREE.Mesh(getFangGeo(), this.mat);
      fang.position.set(side * 0.18, 0.15, 1.45);
      fang.rotation.x = 2.6; // points down-forward
      this.mesh.add(fang);
    }

    // Eyes: two glow sprites on the head — the "it's looking at you" cue.
    // Bigger and angled forward so they read at range.
    const tex = getEyeTex();
    this.eyeMatL = new THREE.SpriteMaterial({ map: tex, color: 0xff3311, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.eyeMatR = this.eyeMatL.clone();
    this.eyeL = new THREE.Sprite(this.eyeMatL);
    this.eyeR = new THREE.Sprite(this.eyeMatR);
    const s = this.radius * 0.55;
    this.eyeL.scale.setScalar(s);
    this.eyeR.scale.setScalar(s);
    this.eyeL.position.set(-0.28, 0.55, 1.2);
    this.eyeR.position.set(0.28, 0.55, 1.2);
    this.mesh.add(this.eyeL, this.eyeR);

    this.shadow = new BlobShadow(scene, this.radius * 1.1, 0.35);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) return;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.mat.color.copy(this.color);
    }
    if (this.glowT > 0) {
      this.glowT -= dt;
      if (this.glowT <= 0) this.mat.emissive.setHex(0x1a0503);
    }

    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const distSq = dx * dx + dz * dz;

    // Gravity + integration — crawler is always ballistic; hops come from
    // ground contacts, not from hovering.
    this.vel.y += GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);

    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    const onGround = this.pos.y - this.radius <= gy;
    if (onGround) {
      this.pos.y = gy + this.radius;
      if (this.airborne) this.onLanded?.(this.pos); // airborne→ground transition
      this.airborne = false;
      this.vel.set(0, 0, 0);
      // Pounce that landed adjacent to the player — the shove
      if (this.pounceAirborne) {
        this.pounceAirborne = false;
        if (this.pos.distanceToSquared(playerPos) < 6.25) this.onPounceHit?.(this); // 2.5m
      }
      this.groundThink(dt, terrain, playerPos, distSq);
    } else {
      this.airborne = true;
      // Mid-pounce contact — flying through the player counts too
      if (this.pounceAirborne && this.pos.distanceToSquared(playerPos) < 4) {
        this.pounceAirborne = false;
        this.onPounceHit?.(this);
      }
    }

    // Face travel direction (or the player while winding up)
    if (this.state === 'windup' && distSq > 0.01) {
      this.mesh.rotation.y = Math.atan2(dx, dz);
    } else if (this.vel.lengthSq() > 1) {
      this.mesh.rotation.y = Math.atan2(this.vel.x, this.vel.z);
    }

    // Leg scuttle — fast wiggle while chasing, lazy idle sway, tucked in air
    this.animT += dt;
    const amp = this.airborne ? 0.08 : (this.state === 'wander' ? 0.25 : 0.55);
    for (let i = 0; i < this.legs.length; i++) {
      this.legs[i].rotation.x = Math.sin(this.animT * 16 + i * 1.31) * amp;
    }
    // Eyes widen when it notices you, flare during windup
    const eyeS = this.radius * (this.state === 'wander' ? 0.55 : this.state === 'windup' ? 0.9 : 0.75);
    this.eyeL.scale.setScalar(eyeS);
    this.eyeR.scale.setScalar(eyeS);

    this.mesh.position.copy(this.pos);
    this.shadow.update(this.pos, terrain);
  }

  // Called only while grounded — decide the next hop/pounce
  private groundThink(dt: number, terrain: Terrain, playerPos: THREE.Vector3, distSq: number): void {
    if (this.stunTimer > 0) return;

    if (this.state === 'windup') {
      this.windupTimer -= dt;
      // Crouch + glow ramp — readable telegraph
      const t = 1 - this.windupTimer / CRAWLER_WINDUP;
      // Crouch: squash down, widen — geometry already carries the base squash
      this.mesh.scale.set(this.radius * (1 + t * 0.15), this.radius * (1 - t * 0.4), this.radius * (1 + t * 0.15));
      this.mat.emissive.setRGB(0.6 * t, 0.08 * t, 0);
      if (this.windupTimer <= 0) {
        this.mesh.scale.setScalar(this.radius);
        this.pounce(playerPos);
      }
      return;
    }

    if (distSq < CRAWLER_POUNCE_DIST * CRAWLER_POUNCE_DIST) {
      // In range — wind up and pounce
      this.state = 'windup';
      this.windupTimer = CRAWLER_WINDUP;
      return;
    }

    this.hopTimer -= dt;
    if (this.hopTimer > 0) return;
    this.hopTimer = 0.25 + Math.random() * 0.3;

    if (distSq < CRAWLER_AGGRO_DIST * CRAWLER_AGGRO_DIST) {
      this.state = 'chase';
      // Hop toward the player — ballistic hop, not sliding
      const d = Math.sqrt(distSq) || 0.001;
      this.vel.set(
        ((playerPos.x - this.pos.x) / d) * CRAWLER_HOP_SPEED,
        CRAWLER_HOP_UP,
        ((playerPos.z - this.pos.z) / d) * CRAWLER_HOP_SPEED,
      );
    } else {
      this.state = 'wander';
      // Lazy random wander hops
      if (Math.random() < 0.4) this.wanderYaw += (Math.random() - 0.5) * 2;
      this.vel.set(
        Math.sin(this.wanderYaw) * CRAWLER_HOP_SPEED * 0.35,
        CRAWLER_HOP_UP * 0.8,
        Math.cos(this.wanderYaw) * CRAWLER_HOP_SPEED * 0.35,
      );
    }
  }

  // Solved ballistic arc onto the player — the same math as the ball lunge:
  // pick horizontal speed, solve vy so the arc lands on the target.
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
    this.mat.emissive.setRGB(0.6, 0.1, 0); // flash-hot on launch
    this.glowT = 0.4;
  }

  takeDamage(): boolean {
    this.health--;
    this.flashTimer = 0.15;
    this.mat.color.set(0xffffff);
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force);
    this.stunTimer = CRAWLER_STUN; // blasted crawlers can't instantly re-hop
    if (this.state === 'windup') { // blast cancels the pounce windup
      this.state = 'chase';
      this.mesh.scale.setScalar(this.radius);
      this.mat.emissive.setHex(0x1a0503);
    }
  }

  applyPull(to: THREE.Vector3, force: number): void {
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force);
    this.stunTimer = CRAWLER_STUN;
  }

  dispose(): void {
    this.shadow.dispose();
    this.scene.remove(this.mesh);
    this.mat.dispose();
    this.eyeMatL.dispose();
    this.eyeMatR.dispose();
    // geometry is shared — never dispose
  }
}

// Shared eye glow texture
let _eyeTex: THREE.Texture | null = null;
function getEyeTex(): THREE.Texture {
  if (!_eyeTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    _eyeTex = new THREE.CanvasTexture(c);
  }
  return _eyeTex;
}
