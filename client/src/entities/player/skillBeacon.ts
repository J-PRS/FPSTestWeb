import * as THREE from 'three';
import { getGlowTexture } from '../../effects/glowTexture.js';
import { GRAVITY } from '../../core/config.js';
import { ENERGY } from '../../../../shared/movement.js';
import type { SkillsCtx } from './skills.js';

// Warp beacon — Q-down throws the anchor; it flies/arcs/bounces while Q
// is held, Q-up teleports the player onto it with momentum preserved.
const TL_THROW_SPEED = 45;   // m/s along the crosshair (+ 50% inherit)
const TL_COOLDOWN = 1;     // s after a teleport — energy does the pricing
const TL_MAX_LIFE = 6;     // held beacon fizzles — can't camp it forever
const TL_BOUNCE = 0.35;      // restitution — it skitters, doesn't thud

export class WarpBeacon {
  private beacon: { pos: THREE.Vector3; vel: THREE.Vector3; age: number; grounded: boolean } | null = null;
  cooldown = 0;
  private mesh: THREE.Mesh | null = null;
  private glow: THREE.Sprite | null = null;
  private trailT = 0;

  constructor(private ctx: SkillsCtx) {}

  // ---- Warp beacon ----
  // Q-down throws the beacon; it flies/arcs/bounces while Q is held.
  // Q-up teleports the player onto it with momentum preserved.

  throwBeacon(): void {
    if (this.beacon || this.cooldown > 0) {return;}
    // The ante is on the throw like every other skill — a beacon you
    // can't afford to warp to shouldn't exist. Spend it here and the
    // release's teleport is free (already paid for).
    if (!this.ctx.spendEnergy(ENERGY.skillCost)) {return;}
    this.ctx.skillUsed();
    if (!this.mesh) {
      // Glowing beacon: white-hot octa core + additive halo — it must read
      // as a warp anchor, not a pebble, at 60m against the sand
      this.mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.32),
        new THREE.MeshBasicMaterial({ color: 0xAA_FF_F4 })
      );
      this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: 0x33_FF_DD,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      this.glow.scale.setScalar(2.2);
      this.mesh.add(this.glow);
      this.ctx.scene.add(this.mesh);
    }
    const dir = this.ctx.aimDir();
    this.beacon = {
      pos: new THREE.Vector3(this.ctx.pos.x, this.ctx.pos.y + 1.4, this.ctx.pos.z),
      vel: dir.multiplyScalar(TL_THROW_SPEED).addScaledVector(this.ctx.vel, 0.5),
      age: 0,
      grounded: false,
    };
    this.mesh.visible = true;
    this.mesh.position.copy(this.beacon.pos);
    this.trailT = 0;
    this.ctx.emitWarpThrow(this.beacon.pos.clone(), this.beacon.vel.clone());
  }

  releaseBeacon(): void {
    const b = this.beacon;
    this.beacon = null;
    if (!b) {return;}
    if (this.mesh) {this.mesh.visible = false;}
    // Energy already paid at throw — release just commits the teleport.
    // Land the player just over the beacon — never inside terrain
    const gy = this.ctx.terrain.getHeight(b.pos.x, b.pos.z);
    const from = this.ctx.pos.clone();
    this.ctx.pos.set(b.pos.x, Math.max(b.pos.y + 0.4, gy + 0.4), b.pos.z);
    // Momentum survives the warp (UT rule) — vel untouched
    this.cooldown = TL_COOLDOWN;
    this.ctx.syncMovement();
    this.ctx.markTeleport(); // tell the server this jump is intentional
    this.ctx.emitWarp(from, this.ctx.pos.clone());
  }

  fizzle(): void {
    this.beacon = null;
    if (this.mesh) {this.mesh.visible = false;}
  }

  updateBeacon(dt: number): void {
    const b = this.beacon;
    if (!b) {return;}
    b.age += dt;
    if (b.age > TL_MAX_LIFE) { this.fizzle(); return; }

    if (!b.grounded) {
      b.vel.y += GRAVITY * dt;
      b.pos.addScaledVector(b.vel, dt);
      const gy = this.ctx.terrain.getHeight(b.pos.x, b.pos.z) + 0.28;
      if (b.pos.y <= gy) {
        b.pos.y = gy;
        b.vel.y = Math.abs(b.vel.y) > 3 ? -b.vel.y * TL_BOUNCE : 0;
        b.vel.x *= 0.7; b.vel.z *= 0.7;
        if (b.vel.y === 0 && b.vel.lengthSq() < 4) { b.vel.set(0, 0, 0); b.grounded = true; }
      }
    }
    // Spark trail while airborne — the flight path must be visible to
    // read "I'm about to warp THERE". Grounded beacon just glows.
    if (!b.grounded) {
      this.trailT += dt;
      if (this.trailT >= 0.03) {
        this.trailT = 0;
        this.ctx.emitWarpTick(b.pos);
      }
    }
    if (this.mesh) {
      this.mesh.position.copy(b.pos);
      this.mesh.rotation.y += dt * 8;
      this.mesh.rotation.x += dt * 5;
      // Halo pulses — a live anchor, not a dead pebble
      this.glow?.scale.setScalar(2.2 + Math.sin(b.age * 10) * 0.5);
    }
  }

}
