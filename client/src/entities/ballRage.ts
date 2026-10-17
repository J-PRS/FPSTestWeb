/**
 * ballRage — enrage/dash DRESSING only. The self-direction physics (pull,
 * lunge, stall breaker, leash teleport, bounce) all live in shared/ballSim.ts
 * now — offline and netDriven balls step the identical stepBall; this file
 * keeps the emissive telegraph read on top.
 */
import type * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';
import {
  BALL_ENRAGE_DASH_DIST,
  BALL_ENRAGE_TELEGRAPH_H,
} from '../core/config.js';

/** Flat-field bag — the Ball publishes these. */
export interface BallRageHost {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  enraged: boolean;
  enrageTimer: number;
  dashFlash: number;
  emissive: THREE.Color;
}

/** Director hook — enrage storms light up every ball at once. The state
 *  itself is the sim's (`s.enraged`); this is only the red burn tint. */
export function setEnraged(b: BallRageHost, on: boolean): void {
  if (b.enraged === on) {return;}
  b.enraged = on;
  b.enrageTimer = 0;
  b.emissive.setRGB(on ? 0.55 : 0, 0, 0);
}

// Dash telegraph emissive + post-dash pop. Both paths run this — the
// sim's enraged/enrageTimer fields are mirrored onto the host each tick.
export function tickEnrage(b: BallRageHost, dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
  // While enraged inside lunge range, burn hotter as the ball descends —
  // a falling white-hot ball reads as "it's about to dash".
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
