import * as THREE from 'three';
import { GRAVITY } from '../core/config.js';
import { fxPuff, blastBurst } from './vfx.js';
import type { EffectsManager } from './effects.js';

const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// Locomotion dust + trail spawns — jump/ski/move/fly puffs and the
// bounce redirect burst. Spawn math only; pooling stays in EffectsManager.

export function spawnJetpack(m: EffectsManager, pos: THREE.Vector3): void {
    // Two layers, because one can't win both backgrounds. The old single
    // additive streak vanished against bright sky (additive can't darken
    // anything) and was too small (0.1m) to read on the ground. Core = hot
    // additive flame; smoke = normal-blend wisp that stays legible over
    // sky AND snow.
    _v2.copy(pos); _v2.y -= 1.1; // emit below the feet, like the old -1.1 offset
    fxPuff(_v2, {
      count: 2,
      pos: [0.16, 0, 0.16],
      velMin: [-1.4, -24, -1.4], velMax: [1.4, -15, 1.4],
      lifeMin: 0.16, lifeMax: 0.28,
      sizeScale: 0.7,
      colA: [0.45, 0.8, 1], colB: [0.85, 1, 1],
      additive: true,
    });
    // Exhaust — slower and longer-lived so it hangs under the pack a beat
    // and reads as thrust rather than a downward sprite flick.
    _v3.copy(pos); _v3.y -= 1;
    fxPuff(_v3, {
      count: 2,
      pos: [0.22, 0, 0.22],
      velMin: [-1.1, -11, -1.1], velMax: [1.1, -5, 1.1],
      lifeMin: 0.3, lifeMax: 0.5,
      sizeScale: 1,
      colA: [0.6, 0.66, 0.76], colB: [0.8, 0.86, 0.95],
      gravity: false,
    });
  }

  // Warp beacon trail — emits AT the beacon (spawnJetpack offsets -1.2m
  // for feet, which drags the trail under the disc). Sparks shed backward
  // with a slight sag so the arc of the flight path reads.
export function spawnWarpTrail(pos: THREE.Vector3): void {
    // Was 2 dull opaque sparks — a teleport beacon's flight must read as
    // a tracer at 60m. Additive, brighter, larger, longer-lived.
    fxPuff(pos, {
      count: 4,
      velMin: [-1.5, -1.5, -1.5], velMax: [1.5, 0.5, 1.5],
      lifeMin: 0.35, lifeMax: 0.6,
      sizeScale: 0.8,
      colA: [0.4, 1.4, 1.3], colB: [0.5, 1.6, 1.4],
      additive: true,
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

  // Hard-landing impact — the jump ring reads as a footstep at damage
  // level; a slam knocks real dirt UP: fast ground ring + an upward
  // clod fountain, both scaled by the -v·n hit the sim measured.
export function spawnSlamDust(m: EffectsManager, pos: THREE.Vector3, impact: number): void {
    const groundY = m.terrain ? m.terrain.getHeightVisual(pos.x, pos.z) : pos.y - 1.8;
    const s = Math.min(1, Math.max(0.4, (impact - 20) / 60)); // 0.4 at the T1 floor, 1 past ~80 m/s
    _v2.set(pos.x, groundY + 0.2, pos.z);
    blastBurst(_v2, {
      count: Math.round(14 + s * 14),
      planar: true,
      spdMin: 4 + s * 4, spdMax: 9 + s * 8, vy: 1.5 + s * 2,
      lifeMin: 0.35, lifeMax: 0.7,
      sizeMin: 0.35, sizeMax: 0.6,
      gravity: GRAVITY,
      c1: [0.7, 0.6, 0.45], c2: [0.8, 0.7, 0.5],
      opacity: 0.7,
    }, false);
    // The knocked-up clods — a dirt fountain the ring alone can't sell.
    _v3.set(0, 1, 0);
    blastBurst(_v2, {
      count: Math.round(8 + s * 10),
      dir: _v3, spread: 0.45,
      spdMin: 5 + s * 6, spdMax: 10 + s * 8, vy: 0,
      lifeMin: 0.3, lifeMax: 0.6,
      sizeMin: 0.2, sizeMax: 0.45,
      gravity: GRAVITY,
      c1: [0.6, 0.5, 0.38], c2: [0.75, 0.65, 0.5],
      opacity: 0.8,
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
      c1: [0.5, 1, 1], c2: [0.9, 1, 1],
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

// Ski dust tint per terrain preset — the palette lives in the shader, so
// this is a hand-matched table, not a sample. HDR-scaled like the old
// cool white (plain 1.0 tone-maps to ~0.8 grey under ACES).
const SKI_DUST_TINT: Record<number, [number, number, number]> = {
  0: [1.3, 1.15, 0.9],   // mixed — pale earth
  1: [1.55, 1.25, 0.8],  // desert — sunlit sand
  2: [1.15, 1.05, 0.8],  // grassland — dry dirt
  3: [1.8, 1.9, 2.05],   // snow — the original cool white
  4: [0.95, 0.85, 0.75], // volcanic — ash grey
  5: [1.5, 1.1, 0.75],   // badlands — rust sand
  6: [1.55, 1.3, 0.9],   // coast — beach sand
  7: [1.55, 1.25, 0.8],  // desert hard-sun
};

export function spawnSkiDust(m: EffectsManager, pos: THREE.Vector3, velocity: THREE.Vector3): void {
    const groundY = m.terrain ? m.terrain.getHeightVisual(pos.x, pos.z) : 0;
    // Speed-scaled roostertail. The old fixed count-2 grey puff read as one
    // smudge at every speed and disappeared against snow; a spray that fans
    // up/out and grows with speed is what actually sells the carve.
    const sp = Math.hypot(velocity.x, velocity.z);
    const k = Math.min(1, Math.max(0, (sp - 4) / 26)); // 0 = puttering, 1 = full tuck
    const spread = 0.15 + k * 0.2; // narrow band — reads as ski edges, not a smoke wall
    _v2.set(pos.x, groundY + 0.25, pos.z);
    const tint = SKI_DUST_TINT[m.terrain?.preset ?? 1] ?? SKI_DUST_TINT[1]!;
    fxPuff(_v2, {
      count: 3 + Math.round(k * 3),
      pos: [spread, 0.12, spread],
      // Roostertails are a LOW fan: spray flicks sideways off the ski
      // edges, barely rises, and gravity drops it into a ground-hugging
      // trail. Vertical throw stays ~1m even at full tuck — a fountain
      // over the player's head reads as steam, not carve spray.
      velMin: [-0.9 - k * 1.8, 0.3 + k * 0.4, -0.9 - k * 1.8],
      velMax: [0.9 + k * 1.8, 1.1 + k * 0.9, 0.9 + k * 1.8],
      // Keep a slice of the skier's own motion: the plume streams BEHIND
      // the tracks instead of hanging over the skis.
      shed: [-velocity.x * (0.08 + k * 0.22), 0, -velocity.z * (0.08 + k * 0.22)],
      lifeMin: 0.3, lifeMax: 0.5 + k * 0.4,
      sizeScale: 0.9 + k * 0.6,
      // Normal-blended dust has to overshoot albedo or it tone-maps to
      // dark smoke — the tints are the preset's ground color pushed ~30%
      // hot (roostertail spray reads brighter than the surface it shed).
      colA: [tint[0] * 0.85, tint[1] * 0.85, tint[2] * 0.85], colB: tint,
      gravity: true,
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

