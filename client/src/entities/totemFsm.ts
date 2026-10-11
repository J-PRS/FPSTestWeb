/**
 * totemFsm — the offline state machine (materialize/aim/charge/blinkOut/
 * blinkIn) for the sniper totem, extracted from Totem.ts. States mutate the
 * totem's flat fields through TotemFsmHost — the same state-bag pattern as
 * the *Visual splits, except the host also exposes the FSM's own helpers
 * (lineClear/beginBlink/solveBeam/fireBeam) since aim/charge drive them.
 */
import * as THREE from 'three';
import {
  TOTEM_RANGE, TOTEM_MIN_RANGE, TOTEM_REFIRE,
  TOTEM_CHARGE, TOTEM_RELOCATE_HOPS, TOTEM_MATERIALIZE,
  UBER_TOTEM_CHARGE, UBER_TOTEM_BEAM_WIDTH,
} from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import type { TerrainFoot } from '../effects/terrainFoot.js';

export type TotemState = 'materialize' | 'aim' | 'charge' | 'blinkOut' | 'blinkIn';
export interface TotemCtx { dt: number; dist: number; playerPos: THREE.Vector3; playerVel?: THREE.Vector3 }

const _zeroVel = new THREE.Vector3();

/** Flat fields + FSM helpers the state handlers mutate/call. */
export interface TotemFsmHost {
  state: TotemState;
  stateTimer: number;
  pos: THREE.Vector3;
  radius: number;
  uber: boolean;
  terrain: Terrain;
  foot: TerrainFoot | null;
  onBlink?: (pos: THREE.Vector3) => void;

  bodyScale: number;
  eyeScale: number;
  eyeBright: number;
  beamOn: boolean;
  beamOpacity: number;
  beamWidth: number;
  shimmerOn: boolean;
  shimmerPulse: number;
  chargeGlow: number;

  staggerT: number;
  chargeTimer: number;
  refire: number;
  shotsFired: number;
  blinkTarget: THREE.Vector3;
  blinkCd: number;
  lockPoint: THREE.Vector3;
  lockDir: THREE.Vector3;
  lockDist: number;

  beginBlink(playerPos: THREE.Vector3): void;
  lineClear(target: THREE.Vector3): boolean;
  solveBeam(): void;
  fireBeam(playerPos: THREE.Vector3): void;
}

export const TOTEM_STATES: Record<TotemState, (t: TotemFsmHost, c: TotemCtx) => void> = {
  materialize(t, _c): void {
    const p = 1 - Math.max(0, t.stateTimer / TOTEM_MATERIALIZE);
    t.bodyScale = 0.3 + p * 0.7;
    t.eyeScale = 0.4 + p * 0.4;
    t.eyeBright = p * 0.5;
    if (t.stateTimer <= 0) {
      t.state = 'aim';
      t.bodyScale = 1;
      t.eyeBright = 0.8;
    }
  },
  aim(t, c): void {
    t.refire -= c.dt;
    t.eyeBright = 0.8;
    t.eyeScale = 1.1;
    if (t.staggerT <= 0 && t.blinkCd <= 0 &&
        (c.dist < TOTEM_MIN_RANGE ||
        (t.shotsFired >= TOTEM_RELOCATE_HOPS) ||
        (t.refire <= 0 && !t.lineClear(c.playerPos)))) {
      t.beginBlink(c.playerPos);
      return;
    }
    if (t.refire <= 0 && c.dist < TOTEM_RANGE) {
      t.state = 'charge';
      const charge = t.uber ? UBER_TOTEM_CHARGE : TOTEM_CHARGE;
      t.chargeTimer = charge;
      if (t.uber) {
        // PREDICTIVE LOCK — the beam locks where you WILL BE when it
        // fires, not where you are: pos + vel × charge. Holding a
        // strafe line gets you tagged; the only dodge is changing
        // direction after the lock shows.
        t.lockPoint.copy(c.playerPos)
          .addScaledVector(c.playerVel ?? _zeroVel, charge);
      } else {
        t.lockPoint.copy(c.playerPos); // LOCK the line now — no more tracking
      }
      t.solveBeam();
      t.beamOn = true;
    }
  },
  charge(t, c): void {
    t.chargeTimer -= c.dt;
    const charge = t.uber ? UBER_TOTEM_CHARGE : TOTEM_CHARGE;
    const w0 = t.uber ? UBER_TOTEM_BEAM_WIDTH : 0.65;
    const p = 1 - Math.max(0, t.chargeTimer / charge);
    t.beamWidth = w0 - p * (w0 - 0.1);
    t.beamOpacity = 0.3 + p * 0.55;
    t.eyeBright = 0.8 + p * 0.2;
    t.eyeScale = 1.1 + p * 1.4;
    t.chargeGlow = p * 0.5; // violet charge bleed on the shaft
    if (t.chargeTimer <= 0) {
      t.fireBeam(c.playerPos);
      t.eyeScale = 1.1;
      t.chargeGlow = 0;
      t.state = 'aim';
      t.refire = TOTEM_REFIRE;
t.shotsFired += 1;
    }
  },
  blinkOut(t, _c): void {
    t.bodyScale = Math.max(0, t.stateTimer / 0.25);
    if (t.stateTimer <= 0) {
      t.pos.copy(t.blinkTarget);
      t.pos.y = t.terrain.getHeight(t.pos.x, t.pos.z);
      t.bodyScale = 0;
      t.foot!.mesh.visible = false;
      t.state = 'blinkIn';
      t.stateTimer = 1.1; // long arrival telegraph — shimmer warns before the body exists
    }
  },
  blinkIn(t, _c): void {
    // Shimmer column stands at the arrival spot well before the body
    // appears — a ~1s warning shimmer you can pre-aim or just walk to.
    t.shimmerOn = true;
    t.shimmerPulse = 0.7 * Math.abs(Math.sin(t.stateTimer * 20));
    if (t.stateTimer <= 0) {
      t.shimmerOn = false;
      t.bodyScale = 1;
      t.foot!.conform(t.pos.x, t.pos.z, t.pos.y, t.terrain);
      t.foot!.mesh.visible = true;
      t.state = 'materialize';
      t.stateTimer = TOTEM_MATERIALIZE;
      t.shotsFired = 0;
      // Blink cooldown — random so it doesn't feel metronome-y, long
      // enough that it can't chain-hop away from a chasing player.
      t.blinkCd = 2 + Math.random() * 3;
      t.onBlink?.(t.pos);
    }
  },
};
