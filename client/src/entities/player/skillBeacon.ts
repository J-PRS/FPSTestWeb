import * as THREE from 'three';
import { getGlowTexture } from '../../effects/glowTexture.js';
import { RibbonTrail } from '../../effects/RibbonTrail.js';
import { GRAVITY } from '../../core/config.js';
import { ENERGY } from '../../../../shared/movement.js';
import type { SkillsCtx } from './skills.js';

// Warp beacon — Q-down throws the anchor; it flies/arcs/bounces while Q
// is held, Q-up teleports the player onto it with momentum preserved.
const TL_THROW_SPEED = 45;   // m/s along the crosshair (+ 50% inherit)
const TL_COOLDOWN = 1;     // s after a teleport — energy does the pricing
const TL_MAX_LIFE = 6;     // held beacon fizzles — can't camp it forever
const TL_BOUNCE = 0.35;      // restitution — it skitters, doesn't thud
const _up = new THREE.Vector3(0, 1, 0);

export class WarpBeacon {
  private beacon: { pos: THREE.Vector3; vel: THREE.Vector3; age: number; grounded: boolean } | null = null;
  cooldown = 0;
  private mesh: THREE.Mesh | null = null;
  private glow: THREE.Sprite | null = null;
  private ring: THREE.Mesh | null = null;
  private trailT = 0;
  // Energy ribbon welded to the beacon while it flies — a teleport
  // anchor must read as a streak, not a pebble shedding dust. Owned
  // here: pushed each airborne tick, stopped on landing/fizzle,
  // kept updating through its fade until done → dispose.
  private ribbon: RibbonTrail | null = null;

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
      // Glowing beacon: white-hot octa core + additive halo + a flat
      // orbit ring — it must read as a warp anchor, not a pebble, at
      // 60m against the sand
      this.mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.42),
        new THREE.MeshBasicMaterial({ color: 0xCC_FF_F8 })
      );
      this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: 0x33_FF_DD,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      this.glow.scale.setScalar(3.2);
      this.mesh.add(this.glow);
      // Anchor ring — a flat hoop orbiting the core reads as a tear in
      // space, sells "you will land HERE" harder than a glowing dot.
      this.ring = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.75, 24),
        new THREE.MeshBasicMaterial({ color: 0x44_FF_EE, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
      );
      this.mesh.add(this.ring);
      this.ctx.scene.add(this.mesh);
    }
    const dir = this.ctx.aimDir();
    this.beacon = {
      // Same spawn rule as gun shells (fire.ts MUZZLE_LEAD): on the aim
      // line at the eye, 1m forward — pos is already eye height, the old
      // +1.4 threw it visibly out of the top of the head.
      pos: this.ctx.pos.clone().addScaledVector(dir, 1),
      vel: dir.multiplyScalar(TL_THROW_SPEED).addScaledVector(this.ctx.vel, 0.5),
      age: 0,
      grounded: false,
    };
    this.mesh.visible = true;
    this.mesh.position.copy(this.beacon.pos);
    this.trailT = 0;
    this.ribbon?.dispose();
    this.ribbon = RibbonTrail.acquire(this.ctx.scene, {
      color: 0x55_FF_EE, width: 0.4, life: 0.7, billboard: true, tag: 'warp',
    });
    this.ribbon.follow = this.beacon.pos;
    this.ctx.emitWarpThrow(this.beacon.pos.clone(), this.beacon.vel.clone());
  }

  releaseBeacon(): void {
    const b = this.beacon;
    this.beacon = null;
    this.ribbon?.stop(); // fades out in updateBeacon; the anchor is spent
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
    this.ribbon?.stop();
    if (this.mesh) {this.mesh.visible = false;}
  }

  /** Ribbon lifecycle — ticks even with no live beacon, since a stopped
   *  trail still owes its fade (skipping it freezes the streak mid-air
   *  until the orphan sweep reaps it: a leak path, not a fade). */
  private tickRibbon(dt: number): void {
    const r = this.ribbon;
    if (!r) {return;}
    const b = this.beacon;
    if (b && !b.grounded) {r.push(b.pos, b.vel);}
    r.update(dt);
    if (r.done) { r.dispose(); this.ribbon = null; }
  }

  updateBeacon(dt: number): void {
    this.tickRibbon(dt);
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
        if (b.vel.y === 0 && b.vel.lengthSq() < 4) {
          b.vel.set(0, 0, 0); b.grounded = true;
          // Anchor-set beat: a small cyan burst so the landing point
          // announces itself — that's the spot you're about to warp to.
          this.ribbon?.stop();
          this.ctx.emitBounce(b.pos.clone(), _up);
        }
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
      if (this.ring) {
        // Hoop tumbles on its own axes — orbital, not glued to the core's spin
        this.ring.rotation.x += dt * 6;
        this.ring.rotation.y -= dt * 4;
      }
      // Halo pulses — a live anchor, not a dead pebble
      this.glow?.scale.setScalar(3.2 + Math.sin(b.age * 10) * 0.7);
    }
  }

}
