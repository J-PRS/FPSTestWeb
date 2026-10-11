import * as THREE from 'three';
import {
  TOTEM_RANGE, TOTEM_PEAK_RADIUS, TOTEM_PEAK_MIN_GAIN,
  UBER_TOTEM_HIT_RADIUS, UBER_TOTEM_BEAM_WIDTH,
} from '../core/config.js';
import type { Totem } from './Totem.js';

// Rail telegraph + discharge — peak-seek blink target, LOS march, locked
// beam solve, the hitscan itself, and blast-fizzled charge. The offline
// FSM (totemFsm.ts) drives these; netDriven legs map the sim's state.

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();

export function beginBlinkF(t: Totem, playerPos: THREE.Vector3): void {
    // Gate: staggered (damage-locked) or still on post-blink cooldown —
    // the caller treats a no-op as "stay put".
    if (t.staggerT > 0 || t.blinkCd > 0) {return;}
    // Peak-seek: sample a ring of terrain around the PLAYER'S general
    // bearing, pick the highest point that keeps firing range.
    let bestH = -Infinity;
    let found = false;
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
      const r = 15 + Math.random() * TOTEM_PEAK_RADIUS;
      const x = t.pos.x + Math.cos(a) * r;
      const z = t.pos.z + Math.sin(a) * r;
      const h = t.terrain.getHeight(x, z);
      const pd = Math.hypot(playerPos.x - x, playerPos.z - z);
      if (pd > TOTEM_RANGE * 0.9) {continue;}
      if (h > bestH) { bestH = h; t.blinkTarget.set(x, h, z); found = true; }
    }
    if (!found || bestH < t.terrain.getHeight(t.pos.x, t.pos.z) + TOTEM_PEAK_MIN_GAIN) {
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 20;
      t.blinkTarget.set(playerPos.x + Math.cos(a) * r, 0, playerPos.z + Math.sin(a) * r);
    }
    t.state = 'blinkOut';
    t.stateTimer = 0.25;
    t.beamOn = false;
    t.onBlink?.(t.pos);
  }

  // LOS check — sampled straight-ish line; totem fires nearly flat bolts
  // so terrain grazing matters more than arc clearance.
export function lineClear(t: Totem, target: THREE.Vector3): boolean {
    const sy = t.pos.y + 3.9 * t.radius;
    for (let i = 1; i <= 10; i += 1) {
      const u = i / 10;
      const x = t.pos.x + (target.x - t.pos.x) * u;
      const z = t.pos.z + (target.z - t.pos.z) * u;
      const y = sy + (target.y - sy) * u;
      if (y < t.terrain.getHeight(x, z) + 0.4) {return false;}
    }
    return true;
  }

  // Solve the locked beam once: direction at lockPoint, extended to its
  // full length — terrain hit or TOTEM_RANGE.
export function solveBeam(t: Totem): void {
    _v.set(t.pos.x, t.pos.y + 3.9 * t.radius, t.pos.z); // eye
    t.lockDir.copy(t.lockPoint).sub(_v).normalize();
    t.lockDist = TOTEM_RANGE;
    for (let u = 1; u <= TOTEM_RANGE; u += 1) {
      const x = _v.x + t.lockDir.x * u,
            y = _v.y + t.lockDir.y * u,
            z = _v.z + t.lockDir.z * u;
      if (y < t.terrain.getHeight(x, z)) { t.lockDist = u; break; }
    }
  }

  // Railgun fire: instant hitscan along the LOCKED line. Sidestep during
  // charge and the locked line whiffs you entirely.
export function fireBeam(t: Totem, playerPos: THREE.Vector3): void {
    _v.set(t.pos.x, t.pos.y + 3.9 * t.radius, t.pos.z);
    _dir.copy(t.lockDir);
    const dist = t.lockDist;
    const hitGround = dist < TOTEM_RANGE;

    _v2.subVectors(playerPos, _v);
    const proj = _v2.dot(_dir);
    // Uber's death ray is a fat line — a wider catch envelope matches the
    // telegraph width. It can't miss a held course; it CAN miss a juke.
    const hitR2 = t.uber ? UBER_TOTEM_HIT_RADIUS * UBER_TOTEM_HIT_RADIUS : 1.7;
    if (proj > 0 && proj < dist && _v2.addScaledVector(_dir, -proj).lengthSq() < hitR2) {
      // Impact = the beam point closest to the player — damage/knockback
      // judge from here, not from the obelisk a whole map away.
      _v2.copy(_v).addScaledVector(_dir, proj);
      t.onBoltHit?.(t, _v2);
    } else if (hitGround) {
      _v2.copy(_v).addScaledVector(_dir, dist);
      t.onBoltLand?.(_v2);
    }

    // Post-shot flash: the DISCHARGE — starts wide like the charge beam's
    // full envelope (energy leaving the whole line), snaps thin as it
    // decays. beamFade drives the white-hot color in writeInstances.
    t.beamWidth = t.uber ? UBER_TOTEM_BEAM_WIDTH * 0.5 : 0.3;
    t.beamOpacity = 1;
    t.beamFade = 0.35;
    t.beamOn = true;
  }


// Anchored — a blast during charge drops the aim. Staggered it can't
// even flee: the charge fizzles but the totem holds its ground.
export function blastPush(t: Totem, from: THREE.Vector3, force: number): void {
  if (t.state !== 'charge' || !Number.isFinite(from.x + from.y + from.z + force) || force <= 8) {return;}
  if (t.staggerT > 0 || t.blinkCd > 0) { t.state = 'aim'; t.refire = Math.max(t.refire, 0.4); t.beamOn = false; }
  else {beginBlinkF(t, from);}
}

export function blastPull(t: Totem, to: THREE.Vector3, force: number): void {
  if (t.state !== 'charge' || !Number.isFinite(to.x + to.y + to.z + force) || force <= 8) {return;}
  if (t.staggerT > 0 || t.blinkCd > 0) { t.state = 'aim'; t.refire = Math.max(t.refire, 0.4); t.beamOn = false; }
  else {beginBlinkF(t, to);}
}
