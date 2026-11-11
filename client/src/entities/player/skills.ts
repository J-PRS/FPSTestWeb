import * as THREE from 'three';

import type { Terrain } from '../../world/terrain.js';
import { ENERGY } from '../../../../shared/movement.js';
import { segSolidHit } from '../../../../shared/solidWorld.js';
import { Projectile } from '../../projectiles/Projectile.js';
import type { SkillId } from '../Player.js';
import { SkillChannels } from './skillChannels.js';
import { WarpBeacon } from './skillBeacon.js';

// ---- Skill tuning ----
const _blinkA = new THREE.Vector3(); // blink march scratch — no per-press alloc
const _blinkB = new THREE.Vector3();

const BLINK_RANGE = 20;      // metres along the crosshair
const BLINK_TIME = 0.16;     // lerp duration — reads as a flash, not a slide
// Cooldowns are a spam-breaker, not the economy — the ENERGY.skillCost
// ante is what actually prices skill use, so every one-shot gets a
// uniform 1s floor.
const BLINK_COOLDOWN = 1;

const DASH_IMPULSE = 25;     // m/s added along aim
const DASH_COOLDOWN = 1;   // s between dashes

const SLAM_SPEED = 55;       // m/s straight down
const SLAM_COOLDOWN = 1;   // s


// Energy economy constants live in shared/movement.ts (ENERGY) — the
// server shadow sims the same tank to judge jet/skill claims.
export const SHIELD_DMG_PER_ENERGY = ENERGY.shieldDmgPerEnergy;
export { MEND_HP_PER_SEC } from '../../../../shared/status.js';

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
  emitCloak(on: boolean): void;
  emitShield(on: boolean): void;
  /** Damage landed while shielded → drains energy (dmg/10), breaks at 0. */
  shieldAbsorb(dmg: number): void;
  emitMend(on: boolean): void;
  /** Medkit trickle — offline only; MP heals through the server tick. */
  healSelf(hp: number): void;
  /** True once a server owns health — mend stops self-healing. */
  netHeals(): boolean;
  // Energy is Player-owned — skills spend/drain through these so cloak
  // and jets share the one pool with no duplicated state.
  energy(): number;
  /** Atomic check+deduct: false leaves the pool untouched. */
  spendEnergy(n: number): boolean;
  /** Mirrors the instant-skill ante on the server shadow (skillUse claim). */
  skillUsed(): void;
  /** Unconditional drain — nugget jet-boost does NOT subsidize cloak. */
  drainEnergy(n: number): void;
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
  private slamActive = false;  // falling at slam speed - detonates on landing
  private slamCooldown = 0;

  // Energy-channel toggles (cloak/shield/mend) live in skillChannels.ts.
  private readonly chan: SkillChannels;
  get isCloaked(): boolean { return this.chan.cloaked; }
  get isShielded(): boolean { return this.chan.shielded; }
  get isMending(): boolean { return this.chan.mending; }
  /** Outside forces (damage soak, death) drop the bubble through the
   *  same emit path so the wire flag and FX never disagree. */
  forceShieldOff(): void { this.chan.forceShieldOff(); }

  // Warp beacon (Q-down throws, Q-up teleports) lives in skillBeacon.ts.
  private readonly warp: WarpBeacon;

  constructor(private ctx: SkillsCtx) {
    this.chan = new SkillChannels(ctx);
    this.warp = new WarpBeacon(ctx);
  }

  reset(): void {
    this.bounceArmed = false;
    this.bounceHeld = this.bounceArmed;
    this.blinkActive = false;
    this.slamActive = false;
    this.chan.resetAll();
    this.warp.fizzle();
  }

  // Q pressed - one dispatch point per skill.
  press(skill: SkillId): void {
    if (skill === 'blink') {this.tryBlink();}
    else if (skill === 'dash') {this.tryDash();}
    else if (skill === 'slam') {this.trySlam();}
    else if (skill === 'warp') {this.warp.throwBeacon();}
    else if (skill === 'cloak') {this.chan.toggleCloak();}
    else if (skill === 'shield') {this.chan.toggleShield();}
    else if (skill === 'medkit') {this.chan.toggleMend();}
    else {this.bounceHeld = true;}
  }

  release(skill: SkillId): void {
    this.bounceHeld = false;
    this.bounceArmed = false;
    if (skill === 'warp') {this.warp.releaseBeacon();}
  }

  tickCooldowns(dt: number): void {
    this.blinkCooldown = Math.max(0, this.blinkCooldown - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.slamCooldown = Math.max(0, this.slamCooldown - dt);
    this.warp.cooldown = Math.max(0, this.warp.cooldown - dt);
  }

  updateCloak(dt: number): void { this.chan.updateCloak(dt); }
  updateShield(dt: number): void { this.chan.updateShield(dt); }
  updateMend(dt: number): void { this.chan.updateMend(dt); }
  updateBeacon(dt: number): void { this.warp.updateBeacon(dt); }

  /** The instant-skill ante: spend the energy AND tell the server shadow.
   *  False = the tank can't cover it and the skill fizzles. */
  private paySkill(): boolean {
    if (!this.ctx.spendEnergy(ENERGY.skillCost)) {return false;}
    this.ctx.skillUsed();
    return true;
  }

  private tryBlink(): void {
    if (this.blinkActive || this.blinkCooldown > 0) {return;}

    const dir = this.ctx.aimDir();
    const { pos, terrain } = this.ctx;
    // March the ray — truncate at the last point that stays clear of
    // terrain so you can't blink inside a hillside.
    let dist = 0;
    for (let d = 0.5; d <= BLINK_RANGE; d += 0.5) {
      const px = pos.x + dir.x * d;
      const py = pos.y + dir.y * d;
      const pz = pos.z + dir.z * d;
      if (py < terrain.getHeight(px, pz) + 0.5) {break;}
      dist = d;
    }
    // Structures too — the terrain-only march let a blink phase through
    // base walls. Same swept-segment test the beams and shells use.
    if (dist >= 2 && Projectile.solidColliders.length > 0) {
      _blinkA.copy(pos);
      _blinkB.copy(dir).multiplyScalar(dist).add(pos);
      const hit = segSolidHit(_blinkA, _blinkB, Projectile.solidColliders, Projectile.solidIndex ?? undefined);
      if (hit) {dist = Math.max(0, hit.t * dist - 0.5);}
    }
    if (dist < 2) {return;} // wall in the face — fizzle, no cooldown
    if (!this.paySkill()) {return;} // dry tank — the trick costs real mobility

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
    if (!this.blinkActive) {return false;}
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
    if (this.dashCooldown > 0) {return;}
    if (!this.paySkill()) {return;}
    this.dashCooldown = DASH_COOLDOWN;
    const dir = this.ctx.aimDir();
    this.ctx.vel.addScaledVector(dir, DASH_IMPULSE);
    this.ctx.syncMovement();
    this.ctx.emitDash(this.ctx.pos.clone(), dir.clone());
  }

  private trySlam(): void {
    if (this.ctx.isOnGround() || this.slamCooldown > 0) {return;} // airborne only
    if (!this.paySkill()) {return;}
    this.slamActive = true;
    this.slamCooldown = SLAM_COOLDOWN;
    this.ctx.vel.y = -SLAM_SPEED; // keep horizontal momentum — spike the vertical
    this.ctx.syncMovement();
  }

  // Landing-transition handling — runs after movement.sync each frame.
  // Bounce arms airborne and fires on touchdown; slam detonates on it.
  postMove(wasOnGround: boolean, onGround: boolean, prevVelY: number): void {
    const {ctx} = this;
    // Bounce skill: arm while airborne, fire on the landing transition —
    // redirect full speed along the crosshair. Pure redirect: magnitude
    // preserved, nothing added or taken away.
    if (this.bounceHeld && !onGround) {this.bounceArmed = true;}
    if (this.bounceArmed && !wasOnGround && onGround) {
      const speed = ctx.vel.length();
      if (speed > 0.01 && this.paySkill()) {
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
