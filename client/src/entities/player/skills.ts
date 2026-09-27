import * as THREE from 'three';

import { getGlowTexture } from '../../effects/glowTexture.js';
import type { Terrain } from '../../world/terrain.js';
import { GRAVITY } from '../../core/config.js';
import type { SkillId } from '../Player.js';

// ---- Skill tuning ----
const BLINK_RANGE = 20;      // metres along the crosshair
const BLINK_TIME = 0.16;     // lerp duration — reads as a flash, not a slide
const BLINK_COOLDOWN = 1.2;  // s between blinks

const DASH_IMPULSE = 25;     // m/s added along aim
const DASH_COOLDOWN = 0.9;   // s between dashes

const SLAM_SPEED = 55;       // m/s straight down
const SLAM_COOLDOWN = 1.4;   // s

const TL_THROW_SPEED = 45;   // m/s along the crosshair (+ 50% inherit)
const TL_COOLDOWN = 4.0;     // s after a teleport
const TL_MAX_LIFE = 6.0;     // held beacon fizzles — can't camp it forever
const TL_BOUNCE = 0.35;      // restitution — it skitters, doesn't thud

// Everything a skill needs from Player — mutable refs for pos/vel, plus
// plumbing callbacks (aim, movement sync, the per-frame blink visuals).
export interface SkillsCtx {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  scene: THREE.Scene;
  terrain: Terrain;
  isOnGround(): boolean;
  aimDir(): THREE.Vector3;
  syncMovement(): void;
  markTeleport(): void;
  // Blink suspends physics but still needs the camera/shadow refreshed —
  // Player provides the exact block it used to run inline.
  blinkFrame(): void;
  // FX emitters — Player forwards its assignable on* hooks so skills never
  // touch the class directly.
  emitBlink(from: THREE.Vector3, to: THREE.Vector3): void;
  emitDash(pos: THREE.Vector3, dir: THREE.Vector3): void;
  emitWarpThrow(pos: THREE.Vector3, vel: THREE.Vector3): void;
  emitWarpTick(pos: THREE.Vector3): void;
  emitWarp(from: THREE.Vector3, to: THREE.Vector3): void;
  emitSlam(pos: THREE.Vector3, impactSpeed: number): void;
  emitBounce(pos: THREE.Vector3, dir: THREE.Vector3): void;
}

// Q-slot skill state + behavior: bounce / blink / dash / slam / warp beacon.
// One slot, mutually exclusive skills — Player forwards the keydown/keyup
// and the update-time integration points.
export class PlayerSkills {
  private bounceHeld = false;
  private bounceArmed = false;

  // Blink lerps pos between blinkFrom→blinkTo; blinkSavedVel restores
  // momentum on completion.
  private blinkActive = false;
  private blinkT = 0;
  private blinkCooldown = 0;
  private blinkFrom = new THREE.Vector3();
  private blinkTo = new THREE.Vector3();
  private blinkSavedVel = new THREE.Vector3();

  private dashCooldown = 0;
  private slamActive = false;  // falling at slam speed — detonates on landing
  private slamCooldown = 0;

  private tlBeacon: { pos: THREE.Vector3; vel: THREE.Vector3; age: number; grounded: boolean } | null = null;
  private tlCooldown = 0;
  private tlMesh: THREE.Mesh | null = null;
  private tlGlow: THREE.Sprite | null = null;
  private tlTrailT = 0;

  constructor(private ctx: SkillsCtx) {}

  reset(): void {
    this.bounceHeld = this.bounceArmed = false;
    this.blinkActive = false;
    this.slamActive = false;
    this.fizzleBeacon();
  }

  // Q pressed — one dispatch point per skill.
  press(skill: SkillId): void {
    if (skill === 'blink') this.tryBlink();
    else if (skill === 'dash') this.tryDash();
    else if (skill === 'slam') this.trySlam();
    else if (skill === 'warp') this.throwBeacon();
    else this.bounceHeld = true;
  }

  release(skill: SkillId): void {
    this.bounceHeld = false;
    this.bounceArmed = false;
    if (skill === 'warp') this.releaseBeacon();
  }

  tickCooldowns(dt: number): void {
    this.blinkCooldown = Math.max(0, this.blinkCooldown - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.slamCooldown = Math.max(0, this.slamCooldown - dt);
    this.tlCooldown = Math.max(0, this.tlCooldown - dt);
  }

  private tryBlink(): void {
    if (this.blinkActive || this.blinkCooldown > 0) return;

    const dir = this.ctx.aimDir();
    const { pos, terrain } = this.ctx;
    // March the ray — truncate at the last point that stays clear of
    // terrain so you can't blink inside a hillside.
    let dist = 0;
    for (let d = 0.5; d <= BLINK_RANGE; d += 0.5) {
      const px = pos.x + dir.x * d;
      const py = pos.y + dir.y * d;
      const pz = pos.z + dir.z * d;
      if (py < terrain.getHeight(px, pz) + 0.5) break;
      dist = d;
    }
    if (dist < 2) return; // wall in the face — fizzle, no cooldown

    this.blinkFrom.copy(pos);
    this.blinkTo.copy(dir).multiplyScalar(dist).add(pos);
    this.blinkSavedVel.copy(this.ctx.vel);
    this.blinkT = 0;
    this.blinkActive = true;
    this.blinkCooldown = BLINK_COOLDOWN;
    this.ctx.vel.set(0, 0, 0);
    this.ctx.emitBlink(this.blinkFrom, this.blinkTo);
  }

  // Blink: physics suspended, position lerps along the stored path,
  // velocity held at zero until the restore on completion. Returns true
  // while active — Player's update early-outs on it.
  updateBlink(dt: number): boolean {
    if (!this.blinkActive) return false;
    this.blinkT += dt / BLINK_TIME;
    const t = Math.min(this.blinkT, 1);
    const ease = t * t * (3 - 2 * t); // smoothstep — snap in, settle out
    this.ctx.pos.lerpVectors(this.blinkFrom, this.blinkTo, ease);
    if (t >= 1) {
      this.blinkActive = false;
      this.ctx.vel.copy(this.blinkSavedVel);
    }
    this.ctx.blinkFrame();
    return true;
  }

  private tryDash(): void {
    if (this.dashCooldown > 0) return;
    this.dashCooldown = DASH_COOLDOWN;
    const dir = this.ctx.aimDir();
    this.ctx.vel.addScaledVector(dir, DASH_IMPULSE);
    this.ctx.syncMovement();
    this.ctx.emitDash(this.ctx.pos.clone(), dir.clone());
  }

  private trySlam(): void {
    if (this.ctx.isOnGround() || this.slamCooldown > 0) return; // airborne only
    this.slamActive = true;
    this.slamCooldown = SLAM_COOLDOWN;
    this.ctx.vel.y = -SLAM_SPEED; // keep horizontal momentum — spike the vertical
    this.ctx.syncMovement();
  }

  // ---- Warp beacon ----
  // Q-down throws the beacon; it flies/arcs/bounces while Q is held.
  // Q-up teleports the player onto it with momentum preserved.

  private throwBeacon(): void {
    if (this.tlBeacon || this.tlCooldown > 0) return;
    if (!this.tlMesh) {
      // Glowing beacon: white-hot octa core + additive halo — it must read
      // as a warp anchor, not a pebble, at 60m against the sand
      this.tlMesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.32),
        new THREE.MeshBasicMaterial({ color: 0xaafff4 })
      );
      this.tlGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlowTexture(),
        color: 0x33ffdd,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      this.tlGlow.scale.setScalar(2.2);
      this.tlMesh.add(this.tlGlow);
      this.ctx.scene.add(this.tlMesh);
    }
    const dir = this.ctx.aimDir();
    this.tlBeacon = {
      pos: new THREE.Vector3(this.ctx.pos.x, this.ctx.pos.y + 1.4, this.ctx.pos.z),
      vel: dir.multiplyScalar(TL_THROW_SPEED).addScaledVector(this.ctx.vel, 0.5),
      age: 0,
      grounded: false,
    };
    this.tlMesh.visible = true;
    this.tlMesh.position.copy(this.tlBeacon.pos);
    this.tlTrailT = 0;
    this.ctx.emitWarpThrow(this.tlBeacon.pos.clone(), this.tlBeacon.vel.clone());
  }

  private releaseBeacon(): void {
    const b = this.tlBeacon;
    this.tlBeacon = null;
    if (!b) return;
    if (this.tlMesh) this.tlMesh.visible = false;
    // Land the player just over the beacon — never inside terrain
    const gy = this.ctx.terrain.getHeight(b.pos.x, b.pos.z);
    const from = this.ctx.pos.clone();
    this.ctx.pos.set(b.pos.x, Math.max(b.pos.y + 0.4, gy + 0.4), b.pos.z);
    // Momentum survives the warp (UT rule) — vel untouched
    this.tlCooldown = TL_COOLDOWN;
    this.ctx.syncMovement();
    this.ctx.markTeleport(); // tell the server this jump is intentional
    this.ctx.emitWarp(from, this.ctx.pos.clone());
  }

  private fizzleBeacon(): void {
    this.tlBeacon = null;
    if (this.tlMesh) this.tlMesh.visible = false;
  }

  updateBeacon(dt: number): void {
    const b = this.tlBeacon;
    if (!b) return;
    b.age += dt;
    if (b.age > TL_MAX_LIFE) { this.fizzleBeacon(); return; }

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
      this.tlTrailT += dt;
      if (this.tlTrailT >= 0.03) {
        this.tlTrailT = 0;
        this.ctx.emitWarpTick(b.pos);
      }
    }
    if (this.tlMesh) {
      this.tlMesh.position.copy(b.pos);
      this.tlMesh.rotation.y += dt * 8;
      this.tlMesh.rotation.x += dt * 5;
      // Halo pulses — a live anchor, not a dead pebble
      this.tlGlow?.scale.setScalar(2.2 + Math.sin(b.age * 10) * 0.5);
    }
  }

  // Landing-transition handling — runs after movement.sync each frame.
  // Bounce arms airborne and fires on touchdown; slam detonates on it.
  postMove(wasOnGround: boolean, onGround: boolean, prevVelY: number): void {
    const ctx = this.ctx;
    // Bounce skill: arm while airborne, fire on the landing transition —
    // redirect full speed along the crosshair. Pure redirect: magnitude
    // preserved, nothing added or taken away.
    if (this.bounceHeld && !onGround) this.bounceArmed = true;
    if (this.bounceArmed && !wasOnGround && onGround) {
      const speed = ctx.vel.length();
      if (speed > 0.01) {
        const dir = ctx.aimDir();
        ctx.vel.copy(dir).multiplyScalar(speed);
        ctx.syncMovement();
        ctx.emitBounce(ctx.pos.clone(), dir.clone());
      }
      this.bounceArmed = false;
    }

    // Slam detonation — the landing IS the trigger (mutually exclusive
    // with Bounce since they're one skill slot, so no ordering conflict)
    if (this.slamActive && !wasOnGround && onGround) {
      this.slamActive = false;
      ctx.emitSlam(ctx.pos.clone(), Math.max(0, -prevVelY));
    }
  }
}
