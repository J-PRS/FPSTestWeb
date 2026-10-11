/**
 * ballRage — the ball's self-direction family: enrage pull + dash
 * telegraph, the stall breaker, ground-bounce physics (energy-metered),
 * the rage-discharging lunge, and the too-far teleport. balls.ts keeps
 * wire handling (net segments, damage claims) and render plumbing; this
 * file owns how a ball chases a player. Everything mutates flat fields
 * on the Ball via BallRageHost — same state-bag pattern as the visual
 * splits.
 */
import * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';
import { ChildLogger } from '../core/Logger.js';
import {
  GRAVITY,
  BALL_ENRAGE_FORCE, BALL_ENRAGE_TIMEOUT, BALL_ENRAGE_DASH_DIST,
  BALL_ENRAGE_TELEGRAPH_H, BALL_ENRAGE_DASH_SPEED, BALL_ENRAGE_ENABLED,
  BALL_MAX_DIST, BALL_TELE_MIN, BALL_TELE_MAX, BALL_TELE_MARGIN,BALL_SLIDE_ENABLED,BALL_SLIDE_VN_MIN
} from '../core/config.js';
import { BALL_OVERSPEED, BALL_MIN_SPEED, BALL_STALL_TIME, BALL_REST_SPEED } from '../../../shared/ballSim.js';

import { SPAWN_POP_S } from './ballVisual.js';

const logger = new ChildLogger('Ball');

const BALL_GRAVITY = GRAVITY;
const BOUNCE = 1;
const _enrageTint = new THREE.Color(1, 0.12, 0.08);
const _enrageDir = new THREE.Vector3();

/** Flat-field bag — the Ball publishes these. */
export interface BallRageHost {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  enraged: boolean;
  enrageTimer: number;
  dashFlash: number;
  dampNextBounce: boolean;
  lastBounceEnergy: number;
  slowTimer: number;
  netDriven: boolean;
  netS: { netAcc: number };
  _rpos: THREE.Vector3;
  emissive: THREE.Color;
  color: THREE.Color;
  trails: { burst(n: number, pos: THREE.Vector3, r: number, c: THREE.Color): void };
  /** Position jump: stop the old tails so they FADE OUT in place —
   *  never hard-clear; a one-frame vanish reads as a glitch. */
  retireRibbons(): void;
  spawnPopT: number;
  onBounce?: (pos: THREE.Vector3, vel: THREE.Vector3) => void;
}

// Stall breaker — loitering under MIN_SPEED for STALL_TIME earns a free
// spring launch at the target (same skill as the enrage launch, fired
// on boredom instead of distance). Mirrors shared/ballSim.ts — a ball
// resting in a dip can't just sit there being scenery.
export function tickStallBreaker(b: BallRageHost, dt: number, playerPos: THREE.Vector3): void {
  const sp = b.vel.length();
  b.slowTimer = sp < BALL_MIN_SPEED ? b.slowTimer + dt : 0;
  if (b.slowTimer < BALL_STALL_TIME) {return;}
  b.slowTimer = 0;
  launchAt(b, playerPos, Math.SQRT1_2);
  b.dashFlash = 0.15;
  b.trails.burst(8, b._rpos, b.radius, b.color);
  b.onBounce?.(b.pos.clone(), b.vel.clone());
}

// Enrage pull + dash telegraph emissive + post-dash pop.
export function tickEnrage(b: BallRageHost, dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
  // Enraged balls are pulled toward the player — a linear accel, so they
  // still bounce and arc naturally instead of homing like missiles.
  // (netDriven: the shared stepper already applied this pull above.)
  if (b.enraged && !b.netDriven) {
    b.enrageTimer += dt;
    _enrageDir.subVectors(playerPos, b.pos);
    _enrageDir.y += b.radius; // aim at the body, not the feet
    const d = _enrageDir.length();
    if (d > 0.001) {
      b.vel.addScaledVector(_enrageDir.multiplyScalar(1 / d), BALL_ENRAGE_FORCE * dt);
    }
    // Calm down once back in play range; give up and teleport if it can
    // never catch up (player teleporting/skiing away at speed)
    // Rage only discharges via a lunge (in handleGroundBounce) or the
    // timeout fallback — a ball that can't catch up eventually teleports
    if (b.enrageTimer > BALL_ENRAGE_TIMEOUT) {
      setEnraged(b, false);
      teleportNearPlayer(b, terrain, playerPos);
    }
  }

  // Dash telegraph: while enraged inside lunge range, burn hotter as the
  // ball descends — a falling white-hot ball reads as "it's about to dash"
  if (b.enraged) {
    const ddx = b.pos.x - playerPos.x;
    const ddz = b.pos.z - playerPos.z;
    if (ddx * ddx + ddz * ddz <= BALL_ENRAGE_DASH_DIST * BALL_ENRAGE_DASH_DIST) {
      const dg = terrain.getHeight(b.pos.x, b.pos.z);
      const h = b.pos.y - (Number.isFinite(dg) ? dg : 0) - b.radius;
      const t = Math.min(1, Math.max(0, 1 - h / BALL_ENRAGE_TELEGRAPH_H));
      b.emissive.setRGB(0.55 + 0.45 * t, 0.45 * t, 0.35 * t); // red → white-hot
    } else {
      // Pulsing red burn — a static tint reads as texture; a ~2.5Hz throb
      // reads as "hostile". Bright enough to push past any base hue.
      const p = 0.75 + 0.85 * (0.5 + 0.5 * Math.sin(b.enrageTimer * 15));
      b.emissive.setRGB(p, p * 0.1, p * 0.08);
    }
  }
  if (b.dashFlash > 0) {
    b.dashFlash -= dt;
    b.emissive.setRGB(1, 0.9, 0.7); // post-dash pop
    if (b.dashFlash <= 0 && b.enraged) {b.emissive.setRGB(0.55, 0, 0);}
  }
}

export function handleGroundBounce(b: BallRageHost, terrain: Terrain, playerPos: THREE.Vector3): void {
  const gy = terrain.getHeight(b.pos.x, b.pos.z);
  if (!Number.isFinite(gy) || b.pos.y - b.radius > gy) {return;}
  b.pos.y = gy + b.radius;
  const n = terrain.getNormal(b.pos.x, b.pos.z);
  const dot = b.vel.dot(n);

  // Only treat as a bounce when the ball is moving INTO the surface (dot < 0).
  // This prevents a spurious re-bounce when update() is called with dt=0 right
  // after a playback keyframe snap: the ball sits exactly on the ground with
  // upward velocity, and without this guard the reflection would flip it back
  // downward, causing a one-frame dip/stutter (and a possible stray teleport).
  if (dot >= 0) {return;}

  // Enraged lunge: touching down within range launches at the player
  // instead of a normal bounce — velocity is REPLACED (clean readable dash,
  // not a bounce that adds up unpredictably)
  if (b.enraged && tryEnrageLunge(b, playerPos)) {return;}

  // Rest: a truly dead impact parks (stall breaker owns the wake-up).
  // Mirrors shared/ballSim.ts — the offline path was missing this settle
  // entirely and micro-skipped forever.
  const impactSpeed = b.vel.length();
  if (impactSpeed < BALL_REST_SPEED) {
    b.vel.set(0, 0, 0);
    chaseIfFar(b, terrain, playerPos);
    return;
  }
  // Dead contact (PhysX bounceThreshold): a graze too weak to bounce
  // slides — cancel the inward normal only, tangential speed rides on.
  // No bounce keyframe: nothing trajectory-changing happened.
  if (BALL_SLIDE_ENABLED && -dot < BALL_SLIDE_VN_MIN) {
    b.vel.addScaledVector(n, -dot);
    chaseIfFar(b, terrain, playerPos);
    return;
  }

  // Calculate total mechanical energy at bounce: KE + PE
  // KE = 0.5 * v^2, PE = g * (global height above reference)
  // Use fixed reference (y=0) to account for terrain height changes
  const velBeforeReflection = b.vel.clone();
  const totalEnergy = 0.5 * velBeforeReflection.lengthSq() + Math.abs(BALL_GRAVITY) * b.pos.y;

  // Post-dash landing OR an overspeed impact: reflect at 50% elasticity
  // so the segment ends with a thud, not a full-energy ricochet into
  // orbit. (Mirrors shared/ballSim.ts BALL_OVERSPEED — keep in sync.)
  const elasticity = (b.dampNextBounce || velBeforeReflection.length() > BALL_OVERSPEED) ? 0.5 : BOUNCE;
  b.dampNextBounce = false;
  b.vel.addScaledVector(n, -(1 + elasticity) * dot);

  // Check if reflection itself preserves energy (should be 100% with BOUNCE=1.0)
  const velAfterMag = b.vel.length();
  const velBeforeMag = velBeforeReflection.length();
  const reflectionEnergyRatio = velAfterMag / velBeforeMag;
  if (Math.abs(reflectionEnergyRatio - 1) > 0.01) {
    logger.debug(`Ball reflection lost energy: ${(reflectionEnergyRatio * 100).toFixed(1)}% (should be 100%)`);
  }

  // Compare total mechanical energy to previous bounce
  if (b.lastBounceEnergy > 0) {
    const energyRatio = totalEnergy / b.lastBounceEnergy;
    if (energyRatio < 0.95 || energyRatio > 1.05) {
      const kind = energyRatio < 0.95 ? 'LOSS' : 'GAIN';
      logger.debug(`Ball total energy ${kind}: ${(energyRatio * 100).toFixed(1)}% (KE: ${(0.5 * velBeforeMag * velBeforeMag).toFixed(1)}, PE: ${(Math.abs(BALL_GRAVITY) * b.pos.y).toFixed(1)})`);
    }
  }
  b.lastBounceEnergy = totalEnergy;

  // Record bounce keyframe (after velocity reflection)
  b.onBounce?.(b.pos.clone(), b.vel.clone());
  chaseIfFar(b, terrain, playerPos);
}

// Touchdown within dash range while enraged → ballistic lunge that
// discharges the rage. Returns true when the lunge consumed the bounce.
function tryEnrageLunge(b: BallRageHost, playerPos: THREE.Vector3): boolean {
  const pdx = playerPos.x - b.pos.x;
  const pdz = playerPos.z - b.pos.z;
  if (pdx * pdx + pdz * pdz > BALL_ENRAGE_DASH_DIST * BALL_ENRAGE_DASH_DIST) {return false;}
  dashAt(b, playerPos);
  b.dashFlash = 0.15;
  setEnraged(b, false); // lunge discharges the rage
  b.dampNextBounce = true; // the landing bounce is deadened — no slingshot flyout
  b.trails.burst(8, b._rpos, b.radius, b.color); // dust-burst at takeoff
  b.lastBounceEnergy = 0;
  b.onBounce?.(b.pos.clone(), b.vel.clone());
  return true;
}

// Bounced beyond engagement range: enrage + spring at the player when
// enabled, else teleport back into play.
function chaseIfFar(b: BallRageHost, terrain: Terrain, playerPos: THREE.Vector3): void {
  const dx = b.pos.x - playerPos.x;
  const dz = b.pos.z - playerPos.z;
  if (dx * dx + dz * dz <= BALL_MAX_DIST * BALL_MAX_DIST) {return;}
  if (!BALL_ENRAGE_ENABLED) { teleportNearPlayer(b, terrain, playerPos); return; }
  setEnraged(b, true);
  // Spring at the player on enrage — 45° launch, same redirect physics
  // as the ground lunge. Rage stays ON (this isn't the discharging dash,
  // it's the opening move) until a real lunge lands or timeout hits.
  launchAt(b, playerPos, Math.SQRT1_2);
  b.dashFlash = 0.15;
  b.trails.burst(8, b._rpos, b.radius, b.enraged ? _enrageTint : b.color);
  b.onBounce?.(b.pos.clone(), b.vel.clone());
}

// Redirect velocity toward the player, preserving current speed (floored
// at half dash speed so a dead-slow roll still produces a real launch).
// upFrac is sin(launch angle): 0.34 ≈ flat lunge, √½ = 45° spring.
function launchAt(b: BallRageHost, playerPos: THREE.Vector3, upFrac: number): void {
  const pdx = playerPos.x - b.pos.x;
  const pdz = playerPos.z - b.pos.z;
  const pd = Math.hypot(pdx, pdz) || 0.001;
  const speed = Math.max(b.vel.length(), BALL_ENRAGE_DASH_SPEED * 0.5);
  const h = Math.sqrt(1 - upFrac * upFrac);
  b.vel.set((pdx / pd) * speed * h, 0, (pdz / pd) * speed * h);
  // Launch angle, plus extra loft if the player is above
  b.vel.y = Math.max(speed * upFrac, (playerPos.y - b.pos.y) * 0.8);
}

// Ballistic lunge: horizontal speed becomes the approach speed, then vy is
// solved so the arc lands on the player after t = dist/hspeed seconds.
// Angles up as needed — over bumps, up at elevated players — instead of a
// flat beeline that eats terrain or hits feet.
function dashAt(b: BallRageHost, playerPos: THREE.Vector3): void {
  const pdx = playerPos.x - b.pos.x;
  const pdz = playerPos.z - b.pos.z;
  const pd = Math.hypot(pdx, pdz) || 0.001;
  const hSpeed = Math.max(Math.hypot(b.vel.x, b.vel.z), BALL_ENRAGE_DASH_SPEED * 0.5);
  const t = Math.max(0.15, pd / hSpeed); // flight time
  const vy = (playerPos.y - b.pos.y + 0.5 * Math.abs(BALL_GRAVITY) * t * t) / t;
  b.vel.set((pdx / pd) * hSpeed, vy, (pdz / pd) * hSpeed);
}

/** Director hook — enrage storms light up every ball at once. */
export function setEnraged(b: BallRageHost, on: boolean): void {
  if (b.enraged === on) {return;}
  b.enraged = on;
  b.enrageTimer = 0;
  // Visual cue: emissive red burn while enraged
  b.emissive.setRGB(on ? 0.55 : 0, 0, 0);
}

// Ball drifted too far from the player — teleport it back into play range
function teleportNearPlayer(b: BallRageHost, terrain: Terrain, playerPos: THREE.Vector3): void {
  const ang = Math.random() * Math.PI * 2;
  const dist = BALL_TELE_MIN + Math.random() * (BALL_TELE_MAX - BALL_TELE_MIN);
  b.pos.x = playerPos.x + Math.cos(ang) * dist;
  b.pos.z = playerPos.z + Math.sin(ang) * dist;
  const tg = terrain.getHeight(b.pos.x, b.pos.z);
  b.pos.y = (Number.isFinite(tg) ? tg : 0) + b.radius + BALL_TELE_MARGIN;

  // Position jumped — retire the ribbons so they fade where they were;
  // a clear() would vanish the whole tail in one frame.
  b.retireRibbons();
  // Spring-in + dust puff — the re-arrival should read as an eruption,
  // not a hard pop into existence.
  b.spawnPopT = SPAWN_POP_S;
  b.trails.burst(12, b.pos, b.radius, b.color);

  // Preserve speed, send it UP like the spawn toss — a stone-skimmer
  // teleported in flat just keeps skimming; the leash's job is to put
  // the ball back in the AIR (midair fodder), not re-lay it on the dirt.
  const currentSpeed = Math.max(b.vel.length(), 14);
  const upFrac = 0.75 + Math.random() * 0.2;
  const a2 = Math.random() * Math.PI * 2;
  const hsp = currentSpeed * Math.sqrt(1 - upFrac * upFrac);
  b.vel.set(Math.cos(a2) * hsp, currentSpeed * upFrac, Math.sin(a2) * hsp);

  // Reset the tracking baseline only — the ball keeps its absolute speed
  b.lastBounceEnergy = 0;
  // Record teleport as a bounce keyframe too (position + velocity reset)
  b.onBounce?.(b.pos.clone(), b.vel.clone());
}
