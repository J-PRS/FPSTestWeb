import * as THREE from 'three';

import { GRAVITY, BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import { getGlowTexture } from '../effects/glowTexture.js';
import { BallTrailDots } from '../effects/ballTrails.js';

// Tighter falloff than the shared glow: hot core, fast edge fade — the
// halo marks the item at range without washing a big blob over it.
const getNuggetTex = () => getGlowTexture(32, 0.12, 0.5);

const NUGGET_RADIUS = 0.3;
const INHERIT_VEL = 0.5;      // fraction of destroyed target's velocity
const BOUNCE = 0.25;          // vertical restitution on terrain hits
const GROUND_FRICTION = 0.6;  // horizontal damping per bounce
const SETTLE_SPEED = 0.8;     // below this on ground => settle
const MAGNET_RADIUS = 7;    // start flying toward player inside this
const PICKUP_RADIUS = 1.3;
const MAGNET_ACCEL = 90;      // lerp toward target speed
const MAGNET_MAX_SPEED = 45;
const TRAIL_INTERVAL = 0.035;
const LIFETIME = 30;          // despawn if never picked up

const NUGGET_GEO = new THREE.IcosahedronGeometry(NUGGET_RADIUS, 0);
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Nugget: Vampire-Survivors-style pickup gem dropped by destroyed targets.
 * Inherits a fraction of the victim's velocity, tumbles under gravity,
 * bounces/settles on terrain, then magnet-flies to the player when close.
 */
export class Nugget {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  collected = false; // pickup radius reached
  collectNotified = false; // set by caller once pickup effects/score are applied
  dead = false;      // fully finished — safe to remove + dispose
  /** Server-owned gem (MP): no magnet, no local collect, no local TTL —
   *  the wire decides when it's picked up; we just run the same physics. */
  serverOwned = false;

  private scene: THREE.Scene;
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
  private accentMat: THREE.MeshBasicMaterial | null = null;
  private glow: THREE.Sprite;
  private glowMat: THREE.SpriteMaterial;
  private trailFx: BallTrailDots;
  private trailTimer = 0;
  private age = 0;
  private settled = false;
  private collectFade = 0;
  private scatterTimer = 0; // blast knockback suppresses the magnet briefly
  private baseColor: THREE.Color;
  private emitColor: THREE.Color;

  /** tint: pickup kind sells itself by color — gold gems, green heals,
   *  red tags — no marquee iconography needed. `parts` swaps the plain
   *  gem for a diegetic shape: dark body + accent part in the tint. */
  constructor(scene: THREE.Scene, pos: THREE.Vector3, inheritVel: THREE.Vector3, tint = 0xFFD54A, parts: { body: THREE.BufferGeometry; accent: THREE.BufferGeometry; bodyColor?: number } | null = null) {
    this.scene = scene;
    this.baseColor = new THREE.Color(tint);
    // Emit slightly desaturated so bloom reads hot without clipping to white
    this.emitColor = this.baseColor.clone().lerp(new THREE.Color(0xFFFFFF), 0.33);
    this.pos = pos.clone();
    this.vel = inheritVel.clone().multiplyScalar(INHERIT_VEL);
    // Small random spread so multi-nugget drops scatter naturally
    this.vel.x += (Math.random() - 0.5) * 4;
    this.vel.y += Math.random() * 3 + 1;
    this.vel.z += (Math.random() - 0.5) * 4;

    if (parts) {
      this.mat = new THREE.MeshStandardMaterial({ color: parts.bodyColor ?? 0x3A4048, roughness: 0.45, metalness: 0.75 });
      this.accentMat = new THREE.MeshBasicMaterial({ color: this.emitColor.clone().multiplyScalar(EMIT_GAIN) });
      this.mesh = new THREE.Mesh(parts.body, this.mat);
      const am = new THREE.Mesh(parts.accent, this.accentMat);
      am.layers.enable(BLOOM_LAYER);
      this.mesh.add(am);
    } else {
      this.mat = new THREE.MeshBasicMaterial({ color: this.emitColor.clone().multiplyScalar(EMIT_GAIN) });
      this.mesh = new THREE.Mesh(NUGGET_GEO, this.mat);
    }
    this.mesh.position.copy(this.pos);
    this.mesh.layers.enable(BLOOM_LAYER);
    scene.add(this.mesh);

    // Billboarded glow halo — makes the nugget readable at distance
    this.glowMat = new THREE.SpriteMaterial({
      map: getNuggetTex(),
      color: this.baseColor.clone().multiplyScalar(EMIT_GAIN),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Depth bias toward the camera: the billboard's lower half grazing
      // the terrain plane is a depth near-tie, so the bias wins it — but a
      // ridge genuinely IN FRONT of the nugget is a gross depth gap and
      // still occludes. Keeps depthTest for real occlusion, no float-lift.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.scale.setScalar(2.2);
    this.glow.position.copy(this.pos);
    this.glow.layers.enable(BLOOM_LAYER);
    scene.add(this.glow);

    // Gold sparkle trail — one slot in the shared dot batch (was a
    // Sprite + SpriteMaterial per dot, one draw call each).
    this.trailFx = new BallTrailDots(scene, { interval: TRAIL_INTERVAL, sizeMul: 0.5 });
  }

  /** playerPos is the player's eye/camera position (player.pos). */
  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3, pickupScale = 1): void {
    this.age += dt;
    if (!this.serverOwned && this.age > LIFETIME) {this.collected = true;} // fade out if ignored

    if (this.collected) {
      this.updateCollectFade(dt);
      this.trailFx.fade(dt);
      return;
    }

    if (this.scatterTimer > 0) {this.scatterTimer -= dt;}

    // playerPos is the eye position (camera) — aim below it at belt height so
    // pickups sweep into the torso instead of flying into your face
    _target.copy(playerPos).setY(playerPos.y - 0.6);
    const dist = this.pos.distanceTo(_target);

    if (!this.serverOwned && dist < MAGNET_RADIUS && this.scatterTimer <= 0) {
      this.magnetStep(dt, dist, pickupScale);
    } else if (!this.settled) {
      this.ballisticStep(dt, terrain);
    }

    this.pos.addScaledVector(this.vel, dt);
    this.updateVisuals(dt);
    this.emitTrail(dt);
    this.trailFx.fade(dt);
  }

  private updateCollectFade(dt: number): void {
    this.collectFade += dt * 8;
    this.mesh.scale.setScalar(Math.max(0, 1 - this.collectFade));
    this.glowMat.opacity = Math.max(0, 0.85 * (1 - this.collectFade));
    this.glow.scale.setScalar(2.2 * Math.max(0, 1 - this.collectFade));
    if (this.collectFade >= 1 && this.trailFx.size === 0) {this.dead = true;}
  }

  private magnetStep(dt: number, dist: number, pickupScale = 1): void {
    // Accelerate toward player, speed ramps up as it closes in
    _dir.copy(_target).sub(this.pos).normalize();
    const speed = Math.min(MAGNET_MAX_SPEED, MAGNET_ACCEL * this.age * 0.5 + 15);
    this.vel.lerp(_dir.multiplyScalar(speed), Math.min(1, dt * 10));
    this.settled = false;
    if (dist < PICKUP_RADIUS * pickupScale) {this.collected = true;}
  }

  private ballisticStep(dt: number, terrain: Terrain): void {
    this.vel.y += GRAVITY * dt;
    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y + this.vel.y * dt > gy + NUGGET_RADIUS) {return;}
    this.pos.y = gy + NUGGET_RADIUS;
    if (Math.abs(this.vel.y) > 2) {
      this.vel.y = -this.vel.y * BOUNCE;
      this.vel.x *= GROUND_FRICTION;
      this.vel.z *= GROUND_FRICTION;
      return;
    }
    // Resting: bleed off remaining motion, then settle
    this.vel.y = 0;
    this.vel.x *= Math.max(0, 1 - dt * 6);
    this.vel.z *= Math.max(0, 1 - dt * 6);
    if (this.vel.lengthSq() < SETTLE_SPEED * SETTLE_SPEED) {
      this.vel.set(0, 0, 0);
      this.settled = true;
    }
  }

  // Forceable — explosions scatter nuggets. Light objects: full force plus an
  // up-kick so they pop off the dirt instead of skidding. Knocked loose from
  // the settle state; magnet is suppressed for a beat so the blast actually
  // throws them instead of being lerped straight back at the player.
  applyKnockback(from: THREE.Vector3, force: number): void {
    if (this.collected || this.dead) {return;}
    _dir.copy(this.pos).sub(from).normalize();
    this.vel.addScaledVector(_dir, force);
    this.vel.y += force * 0.3;
    this.settled = false;
    this.scatterTimer = 0.4;
  }

  /** Server truth for a knocked-around gem's rest spot — a correction,
   *  not a teleport: only snap when the local tumble diverged for real. */
  serverRest(p: { x: number; y: number; z: number }): void {
    if (this.collected || this.dead) {return;}
    const dx = this.pos.x - p.x, dy = this.pos.y - p.y, dz = this.pos.z - p.z;
    if (dx * dx + dy * dy + dz * dz < 0.5 * 0.5) {return;}
    this.pos.set(p.x, p.y, p.z);
    this.vel.set(0, 0, 0);
    this.settled = true;
  }

  /** Server said someone banked it — fade out where it lies; the wire
   *  burst + rewards are the caller's job. */
  serverCollect(): void {
    if (this.collected || this.dead) {return;}
    this.collected = true;
    this.collectNotified = true;
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (this.collected || this.dead) {return;}
    _dir.copy(to).sub(this.pos).normalize();
    this.vel.addScaledVector(_dir, force);
    this.settled = false;
    this.scatterTimer = 0.4;
  }

  private updateVisuals(dt: number): void {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y += dt * 3;
    this.mesh.rotation.x += dt * 1.2;
    if (this.settled) {
      this.mesh.position.y = this.pos.y + Math.sin(this.age * 2.5) * 0.06;
      const pulse = 1 + Math.sin(this.age * 5) * 0.12;
      (this.accentMat ?? this.mat as THREE.MeshBasicMaterial).color.copy(this.emitColor).multiplyScalar(pulse * EMIT_GAIN);
      this.glowMat.opacity = 0.7 + Math.sin(this.age * 5) * 0.15;
    }
    // Halo stays welded to the nugget — the polygonOffset bias handles the
    // terrain-graze clip, so no visual lift needed.
    this.glow.position.copy(this.mesh.position);
  }

  private emitTrail(dt: number): void {
    const speedSq = this.vel.lengthSq();
    if (speedSq <= 20) {
      this.trailTimer = 0;
      return;
    }
    this.trailTimer += dt;
    while (this.trailTimer >= TRAIL_INTERVAL) {
      this.trailTimer -= TRAIL_INTERVAL;
      this.trailFx.burst(1, this.pos, 0.4, this.baseColor);
    }
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.scene.remove(this.glow);
    this.mat.dispose();
    this.accentMat?.dispose();
    this.glowMat.dispose();
    this.trailFx.dispose();
  }
}
