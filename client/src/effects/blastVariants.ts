import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { blastBurst, type BlastSpec } from './vfx.js';
import type { ExplosionSparks } from './explosionSparks.js';

// Per-weapon blast variants — the alternative recipes ExplosionLayers
// dispatches to (splash/punch/energy/kinetic/arc/bolt/flak) plus the
// direct-hit bonus layers and the electric-spark helper they share.
// The host owns the emission primitives (burst/tinted/shock/ring); this
// owns the art direction of what each weapon class should read as.

export interface BurstLayer {
  count: number;
  countMult: number;
  elvBase: number; elvSpan: number;
  spdMin: number; spdMax: number; spdBoost: number; vy: number;
  lifeMin: number; lifeVar: number; lifeBoost: number;
  sizeMin: number; sizeVar: number; sizeBoost: number;
  gravity: number;
  r1: number; g1: number; b1: number;
  r2: number; g2: number; b2: number;
  kind: 'glow' | 'solid' | 'smoke';
  planar?: boolean;
  g1Var?: number; // random green-channel spread for organic fire variance
  stagger?: number; // emission spread (s) — breathes instead of one-frame pop
  spin?: number;    // billboard rotation ±rad/s (smoke/debris read organic)
}

/** Flat host surface — the primitives the variants compose with. The
 *  ExplosionLayers host implements each of these on itself. */
export interface VariantHost {
  readonly sparks: ExplosionSparks;
  readonly tint: THREE.Color;
  readonly hasTint: boolean;
  spawnBurst(pos: THREE.Vector3, l: BurstLayer): void;
  blastTinted(pos: THREE.Vector3, spec: BlastSpec): void;
  spawnFlash(pos: THREE.Vector3, mult: number): void;
  spawnGroundRing(pos: THREE.Vector3, mult: number, terrain?: Terrain): void;
  allocShock(pos: THREE.Vector3, color: number | THREE.Color, life: number, maxRadius: number, opacity: number): void;
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();

export class BlastVariants {
  constructor(private h: VariantHost) {}

  /** Dispatch to a weapon-class recipe; false means "fall through to the
   *  shared powder blast". */
  spawn(vfx: string | undefined, pos: THREE.Vector3, mult: number,
      directHit: boolean, timeScale: number, terrain?: Terrain): boolean {
    if (vfx === 'splash') {
      // Watery variant (sprinkler) — droplets + mist, no sparks/spikes/
      // shock dome: a hose splashes, it doesn't detonate.
      this.h.spawnFlash(pos, mult * 0.5);
      this.splash(pos, mult, directHit);
      this.h.spawnGroundRing(pos, mult * 0.8, terrain);
      return true;
    }
    if (vfx === 'punch') {
      // Melee swing — a fist isn't an ordnance event. Small dust puff +
      // a couple of streaks, ~0.2s, no flash sprite: the default recipe
      // point-blank to the camera is a self-flashbang every swing.
      this.punch(pos, mult);
      return true;
    }
    if (vfx === 'energy') {
      // Spinfusor/plasma family — an energy discharge, not a powder blast:
      // crisp tinted flash, tight glow core, electric spikes, and the
      // signature hard ring. NO debris chunks or lingering smoke — energy
      // dissipates, it doesn't smolder.
      this.h.spawnFlash(pos, mult * 0.9);
      this.energy(pos, mult, directHit);
      this.h.allocShock(pos, 0xffffff, 0.35, 5.0 * mult * 0.8, 0.35);
      this.h.allocShock(pos, this.h.hasTint ? this.h.tint : 0xffcc66, 0.45, 6.5 * mult * 0.8, 0.5);
      this.electricSparks(pos, mult);
      if (directHit) this.directHitLayers(pos, timeScale);
      this.h.spawnGroundRing(pos, mult * 1.2, terrain); // wider, brighter — the ring IS the read
      return true;
    }
    if (vfx === 'kinetic') {
      // Railgun slug / javelin — a kinetic strike: hard pin-flash + a fan
      // of speedlines + dust. No fireball, no dome — it punctures,
      // it doesn't detonate.
      this.kinetic(pos, mult);
      this.h.spawnGroundRing(pos, mult * 0.6, terrain);
      return true;
    }
    if (vfx === 'arc') {
      // Lightning pop — a capacitor dumping: thin fast spikes + a small
      // hot core + arc sparks. No dome, no smoke.
      this.h.spawnFlash(pos, mult * 0.6);
      this.arc(pos, mult);
      this.electricSparks(pos, mult);
      return true;
    }
    if (vfx === 'bolt') {
      // Rapid-energy pop (plasma repeater, impact nade) — the same SNAP
      // language as 'energy' at half size. A 7.7/s weapon can't fire a
      // full spinfusor bloom per hit or the screen never clears.
      this.h.spawnFlash(pos, mult * 0.55);
      this.bolt(pos, mult);
      this.electricSparks(pos, mult * 0.7);
      if (directHit) this.directHitLayers(pos, timeScale * 0.6);
      this.h.spawnGroundRing(pos, mult * 0.7, terrain);
      return true;
    }
    if (vfx === 'flak') {
      // Air-burst shell — it detonates mid-flight, so the read is a
      // spherical bloom of hot fragments, not a ground-rooted fireball.
      // Small flash, many fast shards, thin wisps; no dome, token ring.
      this.flak(pos, mult);
      this.h.spawnGroundRing(pos, mult * 0.4, terrain);
      return true;
    }
    return false;
  }

  /** Energy layers — spinfusor/plasma: a compact white-hot core wrapped in
   *  the weapon tint, one hard spike fan, and zero smolder. Everything
   *  decays in <0.5s — the hit should read as a SNAP, not a fire. */
  private energy(pos: THREE.Vector3, mult: number, directHit: boolean): void {
    const dh = directHit ? 1.2 : 1.0;
    this.h.spawnBurst(pos, { // hot core — white center bleeding to tint
      count: 34, countMult: mult,
      elvBase: 0.3, elvSpan: Math.PI,
      spdMin: 6, spdMax: 30, spdBoost: dh, vy: 4,
      lifeMin: 0.22, lifeVar: 0.18, lifeBoost: dh,
      sizeMin: 0.4, sizeVar: 0.6, sizeBoost: dh,
      gravity: -6,
      r1: 1, g1: 1, b1: 1, r2: 0.4, g2: 0.4, b2: 0.5, kind: 'glow', stagger: 0.06,
    });
    this.h.blastTinted(pos, { // tint shell — the colored halo around the core
      count: Math.floor(26 * mult),
      elvBase: 0.2, elvSpan: Math.PI * 0.8,
      spdMin: 10, spdMax: 42, vy: 5,
      lifeMin: 0.3, lifeMax: 0.5,
      sizeMin: 0.5, sizeMax: 1.0,
      gravity: -8,
      c1: [0.8, 0.9, 1.0], c2: [0.2, 0.3, 0.5],
      opacity: 0.85, stagger: 0.08,
    });
    this.h.blastTinted(pos, { // spike fan — thin fast energy streaks
      count: Math.floor(12 * mult),
      elvBase: 0.4, elvSpan: Math.PI,
      spdMin: 45, spdMax: 90, vy: 2,
      lifeMin: 0.18, lifeMax: 0.18,
      sizeMin: 0.22, sizeMax: 0.22,
      gravity: 0,
      c1: [0.9, 0.95, 1.0], c2: [0.4, 0.5, 0.7],
      opacity: 0.9,
      stretched: true, stretchLen: 16, stagger: 0.04,
    });
    this.h.spawnBurst(pos, { // lingering motes — the only "tail" energy gets
      count: 18, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 6, spdBoost: 1, vy: 2,
      lifeMin: 0.5, lifeVar: 0.4, lifeBoost: 1,
      sizeMin: 0.06, sizeVar: 0.1, sizeBoost: 1,
      gravity: -2,
      r1: 0.9, g1: 0.95, b1: 1, r2: 0.3, g2: 0.4, b2: 0.6, kind: 'glow', stagger: 0.12,
      planar: true,
    });
  }

  /** Kinetic strike — railgun slug / thrown spear: the impact is a point,
   *  not a volume. Pin flash + one hard speedline fan + a dirt/dust kick.
   *  No dome, no fireball: penetration reads as violence concentrated. */
  private kinetic(pos: THREE.Vector3, mult: number): void {
    blastBurst(pos, { // pin flash — small, very hot, very brief
      count: 1, spdMin: 0, spdMax: 0, vy: 0,
      lifeMin: 0.08, lifeMax: 0.08,
      sizeMin: 4 * mult, sizeMax: 4 * mult,
      gravity: 0,
      c1: [1, 1, 1], c2: [0.7, 0.8, 1.0],
      opacity: 1.0,
    }, true);
    this.h.blastTinted(pos, { // speedline fan — the whole silhouette
      count: Math.floor(16 * mult),
      elvBase: 0.3, elvSpan: Math.PI * 1.2,
      spdMin: 55, spdMax: 110, vy: 4,
      lifeMin: 0.16, lifeMax: 0.28,
      sizeMin: 0.18, sizeMax: 0.22,
      gravity: -12,
      c1: [0.8, 0.9, 1.0], c2: [0.3, 0.4, 0.6],
      opacity: 0.9,
      stretched: true, stretchLen: 18, stagger: 0.06,
    });
    this.h.spawnBurst(pos, { // impact dust — soft kicked debris
      count: 10, countMult: mult,
      elvBase: 0.1, elvSpan: Math.PI * 0.5,
      spdMin: 3, spdMax: 14, spdBoost: 1, vy: 5,
      lifeMin: 0.3, lifeVar: 0.3, lifeBoost: 1,
      sizeMin: 0.2, sizeVar: 0.3, sizeBoost: 1,
      gravity: -20,
      r1: 0.55, g1: 0.5, b1: 0.45, r2: 0.2, g2: 0.18, b2: 0.16, kind: 'smoke', stagger: 0.10, spin: 1.2,
      planar: true,
    });
    // A few hot chips — sparks sell the metal-on-metal read
    for (let i = 0; i < Math.floor(5 * mult); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.2) * Math.PI * 0.6;
      const spd = 25 + Math.random() * 40;
      const spark = this.h.sparks.alloc(pos);
      spark.r = 1.0; spark.g = 0.85; spark.b = 0.5;
      spark.o = 0.6;
      spark.vel.set(spd * Math.cos(elv) * Math.sin(ang), spd * Math.sin(elv) + 8, spd * Math.cos(elv) * Math.cos(ang));
      spark.life = 0.4 + Math.random() * 0.3;
    }
  }

  /** Arc pop — a lightning discharge: thin violet-white spikes + a small
   *  sizzling core. Reads as electricity, not ordnance. */
  private arc(pos: THREE.Vector3, mult: number): void {
    this.h.blastTinted(pos, { // jagged spikes — the discharge arcs
      count: Math.floor(14 * mult),
      elvBase: 0.4, elvSpan: Math.PI * 1.2,
      spdMin: 30, spdMax: 70, vy: 3,
      lifeMin: 0.12, lifeMax: 0.22,
      sizeMin: 0.14, sizeMax: 0.2,
      gravity: -6,
      c1: [0.8, 0.9, 1.0], c2: [0.3, 0.4, 0.9],
      opacity: 0.9,
      stretched: true, stretchLen: 12, stagger: 0.05,
    });
    this.h.spawnBurst(pos, { // sizzle core — small, hot, brief
      count: 12, countMult: mult,
      elvBase: 0.3, elvSpan: Math.PI,
      spdMin: 4, spdMax: 18, spdBoost: 1, vy: 3,
      lifeMin: 0.15, lifeVar: 0.15, lifeBoost: 1,
      sizeMin: 0.25, sizeVar: 0.35, sizeBoost: 1,
      gravity: -4,
      r1: 0.85, g1: 0.95, b1: 1, r2: 0.3, g2: 0.4, b2: 0.9, kind: 'glow', stagger: 0.05,
    });
  }

  /** Bolt pop — 'energy' shrunk to repeater scale: tight hot core, a
   *  short spike fan, a few motes. No dome, no smoke — ~0.35s total. */
  private bolt(pos: THREE.Vector3, mult: number): void {
    this.h.spawnBurst(pos, { // compact hot core
      count: 16, countMult: mult,
      elvBase: 0.3, elvSpan: Math.PI,
      spdMin: 5, spdMax: 22, spdBoost: 1, vy: 3,
      lifeMin: 0.18, lifeVar: 0.14, lifeBoost: 1,
      sizeMin: 0.25, sizeVar: 0.4, sizeBoost: 1,
      gravity: -6,
      r1: 1, g1: 1, b1: 1, r2: 0.4, g2: 0.5, b2: 0.6, kind: 'glow', stagger: 0.05,
    });
    this.h.blastTinted(pos, { // short spike fan
      count: Math.floor(7 * mult),
      elvBase: 0.4, elvSpan: Math.PI,
      spdMin: 35, spdMax: 70, vy: 2,
      lifeMin: 0.14, lifeMax: 0.14,
      sizeMin: 0.16, sizeMax: 0.16,
      gravity: 0,
      c1: [0.9, 0.95, 1.0], c2: [0.4, 0.5, 0.7],
      opacity: 0.9,
      stretched: true, stretchLen: 12, stagger: 0.03,
    });
    this.h.spawnBurst(pos, { // few motes — token tail
      count: 8, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 5, spdBoost: 1, vy: 2,
      lifeMin: 0.35, lifeVar: 0.3, lifeBoost: 1,
      sizeMin: 0.05, sizeVar: 0.08, sizeBoost: 1,
      gravity: -2,
      r1: 0.9, g1: 0.95, b1: 1, r2: 0.3, g2: 0.4, b2: 0.6, kind: 'glow', stagger: 0.09,
      planar: true,
    });
  }

  /** Flak air-burst — a spherical bloom of incandescent shell fragments:
   *  the detonation hangs where the shell popped instead of grounding
   *  out. Hot shard swarm + a brief center glow + thin cordite wisps. */
  private flak(pos: THREE.Vector3, mult: number): void {
    blastBurst(pos, { // center flash — smaller than a powder flash
      count: 1, spdMin: 0, spdMax: 0, vy: 0,
      lifeMin: 0.07, lifeMax: 0.07,
      sizeMin: 4.5 * mult, sizeMax: 4.5 * mult,
      gravity: 0,
      c1: [1, 0.95, 0.8], c2: [1, 0.5, 0.15],
      opacity: 1.0,
    }, true);
    this.h.spawnBurst(pos, { // shard swarm — full sphere, fast, hot
      count: 30, countMult: mult,
      elvBase: 0.5, elvSpan: Math.PI,
      spdMin: 18, spdMax: 60, spdBoost: 1, vy: 0,
      lifeMin: 0.25, lifeVar: 0.35, lifeBoost: 1,
      sizeMin: 0.07, sizeVar: 0.12, sizeBoost: 1,
      gravity: -26,
      r1: 1, g1: 0.75, g1Var: 0.25, b1: 0.3, r2: 0.7, g2: 0.2, b2: 0.02, kind: 'glow', stagger: 0.06,
    });
    this.h.spawnBurst(pos, { // cordite wisps — a breath of grey, not a plume
      count: 6, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 4, spdBoost: 1, vy: 1.5,
      lifeMin: 0.7, lifeVar: 0.5, lifeBoost: 1,
      sizeMin: 0.25, sizeVar: 0.3, sizeBoost: 1,
      gravity: -1,
      r1: 0.3, g1: 0.28, b1: 0.26, r2: 0.1, g2: 0.1, b2: 0.1, kind: 'smoke', stagger: 0.10, spin: 1.2,
      planar: true,
    });
    // A few spark chips sell the shell-casing shred
    for (let i = 0; i < Math.floor(4 * mult); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const spd = 30 + Math.random() * 40;
      const spark = this.h.sparks.alloc(pos);
      spark.r = 1.0; spark.g = 0.7; spark.b = 0.3;
      spark.o = 0.5;
      spark.vel.set(spd * Math.cos(elv) * Math.sin(ang), spd * Math.sin(elv), spd * Math.cos(elv) * Math.cos(ang));
      spark.life = 0.35 + Math.random() * 0.25;
    }
  }

  /** Electric spark helper — violet-white trails for energy/arc pops. */
  private electricSparks(pos: THREE.Vector3, mult: number): void {
    const count = Math.floor(6 * Math.min(mult, 2.5));
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.3) * Math.PI * 0.7;
      const spd = 20 + Math.random() * 38;
      const spark = this.h.sparks.alloc(pos);
      if (this.h.hasTint) {
        _c.copy(this.h.tint).lerp(_c2.setRGB(1, 1, 1), 0.3 + Math.random() * 0.4);
        spark.r = _c.r; spark.g = _c.g; spark.b = _c.b;
      } else {
        spark.r = 0.7; spark.g = 0.85; spark.b = 1.0;
      }
      spark.o = 0.55;
      spark.vel.set(spd * Math.cos(elv) * Math.sin(ang), spd * Math.sin(elv) + 7, spd * Math.cos(elv) * Math.cos(ang));
      spark.life = 0.45 + Math.random() * 0.35;
    }
  }

  /** Splash — a lime burst that reads as liquid, not fire:
   *  crown droplets lobbed up and rained down, a fast fine spray, slow
   *  pale mist puffs, and a low sheet skimming the surface. Deliberately
   *  cheap — the hose pops at ~9/s. */
  private splash(pos: THREE.Vector3, mult: number, directHit: boolean): void {
    const dh = directHit ? 1.25 : 1.0;
    this.h.spawnBurst(pos, { // crown — fat droplets arced skyward
      count: 14, countMult: mult,
      elvBase: 0.1, elvSpan: Math.PI * 0.5,
      spdMin: 3, spdMax: 13, spdBoost: dh, vy: 6,
      lifeMin: 0.45, lifeVar: 0.4, lifeBoost: dh,
      sizeMin: 0.22, sizeVar: 0.4, sizeBoost: dh,
      gravity: -30,
      r1: 0.7, g1: 1.0, b1: 0.4, r2: 0.25, g2: 0.55, b2: 0.12, kind: 'glow', stagger: 0.08, spin: 2,
    });
    this.h.spawnBurst(pos, { // fine spray — many small fast droplets
      count: 22, countMult: mult,
      elvBase: 0.15, elvSpan: Math.PI * 0.7,
      spdMin: 8, spdMax: 26, spdBoost: dh, vy: 5,
      lifeMin: 0.2, lifeVar: 0.25, lifeBoost: dh,
      sizeMin: 0.05, sizeVar: 0.1, sizeBoost: dh,
      gravity: -34,
      r1: 0.6, g1: 1.0, b1: 0.35, r2: 0.2, g2: 0.5, b2: 0.1, kind: 'glow', stagger: 0.10, spin: 2.5,
    });
    this.h.spawnBurst(pos, { // mist — pale puffs that linger a beat
      count: 6, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 4, spdBoost: 1, vy: 1.8,
      lifeMin: 0.5, lifeVar: 0.4, lifeBoost: 1,
      sizeMin: 0.3, sizeVar: 0.35, sizeBoost: dh,
      gravity: -3,
      r1: 0.7, g1: 0.95, b1: 0.55, r2: 0.3, g2: 0.45, b2: 0.25, kind: 'smoke', stagger: 0.15, spin: 0.8,
      planar: true,
    });
    this.h.spawnBurst(pos, { // ground sheet — droplets skimming outward
      count: 9, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 6, spdMax: 17, spdBoost: dh, vy: 1.2,
      lifeMin: 0.22, lifeVar: 0.2, lifeBoost: dh,
      sizeMin: 0.08, sizeVar: 0.14, sizeBoost: dh,
      gravity: -18,
      r1: 0.65, g1: 1.0, b1: 0.4, r2: 0.25, g2: 0.55, b2: 0.12, kind: 'glow', stagger: 0.08,
      planar: true,
    });
  }

  /** Punch puff — melee impact cue. A few short streaks + a dust puff,
   *  ~0.2s. No flash sprite, no sparks: a fist isn't an ordnance event,
   *  and anything brighter point-blank reads as a self-flashbang. */
  private punch(pos: THREE.Vector3, mult: number): void {
    blastBurst(pos, {
      count: Math.floor(4 * mult),
      elvBase: 0.5, elvSpan: Math.PI,
      spdMin: 10, spdMax: 22, vy: 0,
      lifeMin: 0.12, lifeMax: 0.12,
      sizeMin: 0.2, sizeMax: 0.2,
      gravity: 0,
      c1: [0.75, 0.83, 0.88], c2: [0.3, 0.35, 0.4],
      opacity: 0.55,
      stretched: true, stretchLen: 8,
    }, true);
    this.h.spawnBurst(pos, { // dust puff — a handful of soft billboards
      count: 6, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 4, spdBoost: 1, vy: 1.5,
      lifeMin: 0.2, lifeVar: 0.15, lifeBoost: 1,
      sizeMin: 0.15, sizeVar: 0.2, sizeBoost: 1,
      gravity: -2,
      r1: 0.6, g1: 0.65, b1: 0.7, r2: 0.3, g2: 0.33, b2: 0.36, kind: 'smoke', stagger: 0.06, spin: 1.5,
      planar: true,
    });
  }

  /** Direct-hit bonus — extra glow core + blue energy burst + twin
   *  shock domes + trail sparks. Sparse on purpose: the bonus is
   *  already three glow layers on top of the base blast. */
  directHitLayers(pos: THREE.Vector3, timeScale: number): void {
    // Layer 6: extra bright white core particles
    this.h.blastTinted(pos, {
      count: Math.floor(60 * timeScale),
      elvBase: 0.5, elvSpan: Math.PI,
      spdMin: 20, spdMax: 70, vy: 10,
      lifeMin: 0.6, lifeMax: 1.0,
      sizeMin: 1.25, sizeMax: 2.0,
      gravity: -25,
      c1: [0.6, 0.8, 1.0], c2: [0.2, 0.4, 0.8],
      opacity: 0.9, stagger: 0.08,
    });

    // Layer 7: Blue energy burst — identifies direct hits by color
    this.h.blastTinted(pos, {
      count: Math.floor(70 * timeScale),
      elvBase: 0.5, elvSpan: Math.PI,
      spdMin: 12, spdMax: 47, vy: 8,
      lifeMin: 0.5, lifeMax: 0.9,
      sizeMin: 0.75, sizeMax: 1.375,
      gravity: -10,
      c1: [0.0, 0.3, 1.0], c2: [0.0, 0.0, 0.4],
      opacity: 0.9, stagger: 0.10,
    });

    // Layers 8+9: Shockwave spheres — white expanding sphere, then blue
    for (const [color, life, maxRadius, opacity] of [
      [0xffffff, 0.5, 10.0 * timeScale, 0.6],
      [0x00ccff, 0.4, 12.0 * timeScale, 0.7],
    ] as const) {
      this.h.allocShock(pos, color, life, maxRadius, opacity);
    }

    // Layer 10: Sparks with trails — mix of orange and blue.
    for (let i = 0; i < Math.floor(18 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI * 0.8;
      const spd = 15 + Math.random() * 30;
      const isBlue = Math.random() < 0.4;

      const spark = this.h.sparks.alloc(pos);
      spark.r = isBlue ? 0.1 : 1.0; spark.g = isBlue ? 0.4 : 0.8 + Math.random() * 0.2; spark.b = isBlue ? 1.0 : 0.3 + Math.random() * 0.3;
      spark.o = 0.55;
      spark.vel.set(
        spd * Math.cos(elv) * Math.sin(ang),
        spd * Math.sin(elv) + 5,
        spd * Math.cos(elv) * Math.cos(ang)
      );
      spark.life = 1.5 + Math.random() * 0.5;
    }
  }
}
