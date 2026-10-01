import * as THREE from 'three';
import { GRAVITY } from '../core/config.js';
import { fxPuff, blastBurst } from './vfx.js';
import type { EffectsManager } from './effects.js';

const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// Locomotion dust + trail spawns — jump/ski/move/fly puffs and the
// bounce redirect burst. Spawn math only; pooling stays in EffectsManager.

export function spawnJetpack(m: EffectsManager, pos: THREE.Vector3): void {
    // quarks-batched — the per-particle mesh pool stayed 1 draw call per
    // puff; now the whole stream batches with every other additive system
    _v2.copy(pos); _v2.y -= 1.1; // emit below the feet, like the old -1.1 offset
    fxPuff(_v2, {
      count: 2,
      pos: [0.15, 0, 0.15],
      velMin: [-1.25, -20, -1.25], velMax: [1.25, -14, 1.25],
      lifeMin: 0.18, lifeMax: 0.30,
      sizeScale: 0.35,
      colA: [0.3, 0.7, 1.0], colB: [0.6, 1.0, 1.0],
      additive: true,
    });
  }

  // Warp beacon trail — emits AT the beacon (spawnJetpack offsets -1.2m
  // for feet, which drags the trail under the disc). Sparks shed backward
  // with a slight sag so the arc of the flight path reads.
export function spawnWarpTrail(pos: THREE.Vector3): void {
    fxPuff(pos, {
      count: 2,
      velMin: [-1, -2, -1], velMax: [1, -0.5, 1],
      lifeMin: 0.25, lifeMax: 0.40,
      colA: [0.35, 0.9, 0.95], colB: [0.35, 1.0, 0.95],
    });
  }

export function spawnJumpDust(m: EffectsManager, pos: THREE.Vector3): void {
    // Ground-level ring + center poof as ONE batched quarks system — the
    // pooled-mesh version cost 20 draw calls per jump.
    const groundY = m.terrain ? m.terrain.getHeightVisual(pos.x, pos.z) : 0;
    _v2.set(pos.x, groundY + 0.2, pos.z);
    blastBurst(_v2, {
      count: 20,
      planar: true,
      spdMin: 3, spdMax: 7, vy: 1.5,
      lifeMin: 0.3, lifeMax: 0.6,
      sizeMin: 0.3, sizeMax: 0.5,
      gravity: GRAVITY,
      c1: [0.7, 0.6, 0.45], c2: [0.8, 0.7, 0.5],
      opacity: 0.6,
    }, false);
  }

  // Bounce skill FX — cyan energy burst kicked along the launch direction
  // plus the dust ring. Directional streaks read as the redirect itself.
export function spawnBounce(m: EffectsManager, pos: THREE.Vector3, dir: THREE.Vector3): void {
    const groundY = m.terrain ? m.terrain.getHeightVisual(pos.x, pos.z) : pos.y - 1.8;
    _v3.set(pos.x, Math.max(pos.y - 1.2, groundY + 0.2), pos.z); // burst at feet

    // Forward cone of bright cyan streaks + a dust ring — both batched;
    // the pooled version cost 28 draws per bounce.
    blastBurst(_v3, {
      count: 18,
      dir, spread: 0.5,
      spdMin: 10, spdMax: 28, vy: 0,
      lifeMin: 0.25, lifeMax: 0.55,
      sizeMin: 0.25, sizeMax: 0.45,
      gravity: 0,
      c1: [0.5, 1.0, 1.0], c2: [0.9, 1.0, 1.0],
      opacity: 0.9,
    }, true);
    blastBurst(_v3, {
      count: 10,
      planar: true,
      spdMin: 4, spdMax: 4.5, vy: 0.8,
      lifeMin: 0.3, lifeMax: 0.5,
      sizeMin: 0.3, sizeMax: 0.45,
      gravity: GRAVITY,
      c1: [0.7, 0.65, 0.55], c2: [0.7, 0.65, 0.55],
      opacity: 0.5,
    }, false);
  }

export function spawnSkiDust(m: EffectsManager, pos: THREE.Vector3, velocity: THREE.Vector3): void {
    const groundY = m.terrain ? m.terrain.getHeightVisual(pos.x, pos.z) : 0;
    _v2.set(pos.x, groundY + 0.3, pos.z);
    fxPuff(_v2, {
      count: 2,
      pos: [0.5, 0, 0.5],
      velMin: [-0.15, 0.1, -0.15], velMax: [0.15, 0.2, 0.15],
      shed: [-velocity.x * 0.05, 0, -velocity.z * 0.05],
      lifeMin: 0.3, lifeMax: 0.6,
      colA: [0.7, 0.65, 0.55], colB: [0.7, 0.65, 0.55],
      gravity: false,
    });
  }

  // Creature ground dust — ONE puff per call, callers emit on a distance
  // accumulator so faster movers naturally kick more. `speed` scales the
  // puff's size/opacity/upthrow; `radius` spreads it under bigger bodies.
  // A roller at speed plows a real roostertail; a grub barely puffs.
export function spawnMoveDust(m: EffectsManager, pos: THREE.Vector3, vel: THREE.Vector3, speed: number, radius: number): void {
    const groundY = m.terrain ? m.terrain.getHeightVisual(pos.x, pos.z) : 0;
    const k = Math.min(1, speed / 14); // 0=creep, 1=hauling
    const n = speed > 8 ? 2 : 1;       // fast movers shed pairs per puff
    const s = 0.55 + k * 0.15;         // shade base — rand range rides colA→colB
    const spread = 0.5 + k;            // (rand-0.5)·(1+k·2)
    _v2.set(pos.x, groundY + 0.15 + k * 0.3, pos.z);
    fxPuff(_v2, {
      count: n,
      pos: [radius * 0.8, 0, radius * 0.8],
      velMin: [-spread, 0.4 + k * 2.2, -spread],
      velMax: [spread, 0.4 + k * 2.2 + 0.6, spread],
      shed: [-vel.x * 0.06, 0, -vel.z * 0.06],
      lifeMin: 0.35 + k * 0.5, lifeMax: 0.55 + k * 0.5,
      sizeScale: 0.6 + k * 0.9,
      colA: [s, s * 0.92, s * 0.72], colB: [s + 0.2, (s + 0.2) * 0.92, (s + 0.2) * 0.72],
      gravity: false,
    });
  }

  // Flyer trail — ONE faint mote per call, callers emit on a distance
  // accumulator. A pale slipstream wisp shed behind the body: not smoke,
  // not a contrail — just enough to make fast silhouettes read motion.
export function spawnFlyTrail(m: EffectsManager, pos: THREE.Vector3, vel: THREE.Vector3, speed: number): void {
    const k = Math.min(1, speed / 18);
    const shade = 0.6 + k * 0.2;
    // Shed slightly back + drift down — a settling slipstream, not a jet
    fxPuff(pos, {
      count: 1,
      pos: [0.2, 0.2, 0.2],
      velMin: [-0.2, -0.3 - k * 0.4, -0.2], velMax: [0.2, -0.3 - k * 0.4, 0.2],
      shed: [-vel.x * 0.1, 0, -vel.z * 0.1],
      lifeMin: 0.5 + k * 0.6, lifeMax: 0.5 + k * 0.6,
      sizeScale: 0.35 + k * 0.4,
      colA: [shade, shade * 0.95, shade * 0.85], colB: [shade, shade * 0.95, shade * 0.85],
      gravity: false,
    });
  }

