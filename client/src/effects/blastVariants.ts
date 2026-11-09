import * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';
import { blastBurst, type BlastSpec } from './vfx.js';
import type { ExplosionSparks } from './explosionSparks.js';

// Per-weapon blast variants - the alternative recipes ExplosionLayers
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
  stagger?: number; // emission spread (s) - breathes instead of one-frame pop
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
  spawnGroundRing(pos: THREE.Vector3, mult: number, terrain?: Terrain, staticRing?: boolean): void;
  allocShock(pos: THREE.Vector3, color: number | THREE.Color, life: number, maxRadius: number, opacity: number): void;
  /** Hot point-light punch - decays inside update() like the shockwaves. */
  spawnLight(pos: THREE.Vector3, color: number, intensity: number, dist: number): void;
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();

export class BlastVariants {
  constructor(private h: VariantHost) {}

  /** Dispatch to a weapon-class recipe; false means "fall through to the
   *  shared powder blast". */
  spawn(vfx: string | undefined, pos: THREE.Vector3, mult: number,
      directHit: boolean, timeScale: number, terrain?: Terrain, staticRing = false): boolean {
    if (vfx === 'splash') {
      // Watery variant (sprinkler) — droplets + mist, no sparks/spikes/
      // shock dome: a hose splashes, it doesn't detonate.
      this.h.spawnFlash(pos, mult * 0.5);
      this.splash(pos, mult, directHit);
      this.h.spawnGroundRing(pos, mult * 0.8, terrain, staticRing);
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
      this.h.allocShock(pos, 0xFF_FF_FF, 0.35, 5 * mult * 0.8, 0.35);
      this.h.allocShock(pos, this.h.hasTint ? this.h.tint : 0xFF_CC_66, 0.45, 6.5 * mult * 0.8, 0.5);
      this.electricSparks(pos, mult);
      if (directHit) {this.directHitLayers(pos, timeScale);}
      this.h.spawnGroundRing(pos, mult * 1.2, terrain); // wider, brighter — the ring IS the read
      return true;
    }
    if (vfx === 'kinetic') {
      // Railgun slug / javelin — a kinetic strike: hard pin-flash + a fan
      // of speedlines + dust. No fireball, no dome — it punctures,
      // it doesn't detonate.
      this.kinetic(pos, mult);
      this.h.spawnGroundRing(pos, mult * 0.6, terrain, staticRing);
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
      if (directHit) {this.directHitLayers(pos, timeScale * 0.6);}
      this.h.spawnGroundRing(pos, mult * 0.7, terrain, staticRing);
      return true;
    }
    if (vfx === 'shellburst') {
      // Black-powder shell burst (cannon/gonne/basilisk): potassium-
      // sulfide WHITE smoke is the signature — a dirty flash, a fat
      // lingering smoke cloud, and dark iron chips. No hot dome, no
      // energy read: a period gun, not a sci-fi blast.
      this.shellburst(pos, mult, terrain);
      this.h.spawnGroundRing(pos, mult * 0.7, terrain, staticRing);
      return true;
    }
    if (vfx === 'flak') {
      // Air-burst shell — it detonates mid-flight, so the read is a
      // spherical bloom of hot fragments, not a ground-rooted fireball.
      // Small flash, many fast shards, thin wisps; no dome, token ring.
      this.flak(pos, mult);
      this.h.spawnGroundRing(pos, mult * 0.4, terrain, staticRing);
      return true;
    }
    return false;
  }

  /** Energy layers — spinfusor/plasma: a compact white-hot core wrapped in
   *  the weapon tint, one hard spike fan, and zero smolder. Everything
   *  decays in <0.5s — the hit should read as a SNAP, not a fire. */
  private energy(pos: THREE.Vector3, mult: number, directHit: boolean): void {
    const dh = directHit ? 1.2 : 1;
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
      sizeMin: 0.5, sizeMax: 1,
      gravity: -8,
      c1: [0.8, 0.9, 1], c2: [0.2, 0.3, 0.5],
      opacity: 0.85, stagger: 0.08,
    });
    this.h.blastTinted(pos, { // spike fan — thin fast energy streaks
      count: Math.floor(12 * mult),
      elvBase: 0.4, elvSpan: Math.PI,
      spdMin: 45, spdMax: 90, vy: 2,
      lifeMin: 0.18, lifeMax: 0.18,
      sizeMin: 0.22, sizeMax: 0.22,
      gravity: 0,
      c1: [0.9, 0.95, 1], c2: [0.4, 0.5, 0.7],
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
      c1: [1, 1, 1], c2: [0.7, 0.8, 1],
      opacity: 1,
    }, true);
    this.h.blastTinted(pos, { // speedline fan — the whole silhouette
      count: Math.floor(16 * mult),
      elvBase: 0.3, elvSpan: Math.PI * 1.2,
      spdMin: 55, spdMax: 110, vy: 4,
      lifeMin: 0.16, lifeMax: 0.28,
      sizeMin: 0.18, sizeMax: 0.22,
      gravity: -12,
      c1: [0.8, 0.9, 1], c2: [0.3, 0.4, 0.6],
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
      r1: 0.55, g1: 0.5, b1: 0.45, r2: 0.2, g2: 0.18, b2: 0.16, kind: 'smoke', stagger: 0.1, spin: 1.2,
      planar: true,
    });
    // A few hot chips — sparks sell the metal-on-metal read
    for (let i = 0; i < Math.floor(5 * mult); i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.2) * Math.PI * 0.6;
      const spd = 25 + Math.random() * 40;
      const spark = this.h.sparks.alloc(pos);
      spark.r = 1; spark.g = 0.85; spark.b = 0.5;
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
      c1: [0.8, 0.9, 1], c2: [0.3, 0.4, 0.9],
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
      c1: [0.9, 0.95, 1], c2: [0.4, 0.5, 0.7],
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

  /** Shellburst — a black-powder detonation: weak dirty flash (black
   *  powder flares poorly vs HE), then the SIGNATURE white-gray smoke
   *  cloud that hangs and drifts, with hot chips riding out through it.
   *  Smoke is the mass of the read — everything else is a garnish. */
  private shellburst(pos: THREE.Vector3, mult: number, terrain?: Terrain): void {
    blastBurst(pos, { // dirty flash — hot, fat, gone in a blink (the oomph)
      count: 1, spdMin: 0, spdMax: 0, vy: 0,
      lifeMin: 0.11, lifeMax: 0.11,
      sizeMin: 5.5 * mult, sizeMax: 5.5 * mult,
      gravity: 0,
      c1: [1, 0.8, 0.45], c2: [0.7, 0.35, 0.12],
      opacity: 1,
    }, true);
    // AOE spark ring — embers born ON the damage envelope's surface
    // (radius = mult × EXPLOSION_VFX_RADIUS / AOE_VFX_SCALE, i.e. the
    // true aoeRadius) flying outward: the blast's real reach drawn as a
    // shell of fire. Reads identical from every angle. A dusty shock
    // dome sweeps the same edge — instant telegraph + traveling wave.
    const aoeR = mult * 7.5;
    // Ground-vs-air edge telegraph: a blast within ~35% of its radius of
    // the dirt drapes the embers on a terrain-hugging circle (the AOE
    // edge you actually dodge), an airburst keeps the full shell. Same
    // getHeight() sampler TerrainRing uses per-vertex — ~40 one-shot
    // reads at spawn, nothing per-frame.
    const groundY = terrain ? terrain.getHeight(pos.x, pos.z) : -Infinity;
    const h = pos.y - groundY;
    const grounded = h < aoeR * 0.35;
    // Sphere∩ground radius: √(R²−h²) — the true intersection circle.
    // (h≤0 → full R, the sphere's equator is underground at the hit point.)
    const edgeR = grounded ? Math.sqrt(Math.max(0, aoeR * aoeR - Math.min(h, 0) ** 2)) : aoeR;
    const ringN = Math.floor(40 * mult);
    for (let i = 0; i < ringN; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      let nx = Math.cos(ang), ny: number, nz = Math.sin(ang);
      if (grounded) {ny = 0;} // flat circle — terrain drape below
      else {ny = Math.random() * 2 - 1; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;}
      const spark = this.h.sparks.alloc(pos);
      spark.r = 1; spark.g = 0.75; spark.b = 0.35;
      spark.o = 0.85;                        // bright — this IS the edge telegraph now
      spark.vel.set(nx * 5, grounded ? 1.5 : ny * 5, nz * 5); // slow drift — the shell holds its edge
      spark.grav = grounded ? 0.1 : 0.15;    // ground ring barely sinks — full gravity pushes it under slopes
      spark.life = 0.6 + Math.random() * 0.4; // linger ~0.6-1.0s
      if (grounded) {
        const wx = pos.x + nx * edgeR, wz = pos.z + nz * edgeR;
        // Offset along the terrain NORMAL, not +y: on a 30° slope a
        // vertical lift only gives cos(θ) of clearance — the ring reads
        // buried on hillsides. 4 finite-difference height reads per
        // spark, all at spawn — cheap.
        const t = terrain!, e = 0.5;
        const hx = t.getHeight(wx + e, wz) - t.getHeight(wx - e, wz);
        const hz = t.getHeight(wx, wz + e) - t.getHeight(wx, wz - e);
        // n = (-∂h/∂x, 1, -∂h/∂z) normalized — the cheap up normal.
        const nl = Math.hypot(hx, 1, hz);
        const lift = 0.5;
        spark.pos.set(wx - (hx / nl) * lift, t.getHeight(wx, wz) + (1 / nl) * lift, wz - (hz / nl) * lift);
      } else {
        spark.pos.set(pos.x + nx * aoeR, pos.y + ny * aoeR, pos.z + nz * aoeR);
      }
    }
    // Artillery read: at siege scale (howitzer, mult≥1.5) a period-gun
    // puff undersells a 20m+ killzone — add the fireball dome + second
    // flash punch the cannon-family small rounds deliberately skip.
    if (mult >= 1.5) {
      blastBurst(pos, { // fireball dome — the hot orange canopy a big shell earns
        count: Math.floor(8 * mult), spdMin: 4, spdMax: 12, vy: 4,
        lifeMin: 0.4, lifeMax: 0.7,
        sizeMin: 2.2 * mult, sizeMax: 3.2 * mult,
        gravity: -4,
        c1: [1, 0.62, 0.22], c2: [0.85, 0.28, 0.06],
        opacity: 0.9,
      }, true);
      this.h.spawnFlash(pos, mult * 0.85);
      // The two multipliers the recipe was missing: a hot light that
      // lights terrain+flesh for a beat, and a fast shock shell scaling
      // out with the wavefront (distinct from the terrain AOE-edge ring).
      this.h.spawnLight(pos, 0xFF_AA_44, 60 * mult, 14 * mult);
      this.h.allocShock(pos, 0xFF_CC_88, 0.22, 7.5 * mult, 0.5);
      // Aftermath: the blast dies fast but the field shouldn't. Ember
      // rain - glowing bits arcing out and drifting down for seconds,
      // and a slow dust column rising on the thermal updraft.
      for (let i = 0; i < Math.floor(30 * mult); i += 1) {
        const s = this.h.sparks.alloc(pos);
        s.r = 1; s.g = 0.55 + Math.random() * 0.25; s.b = 0.15;
        s.o = 0.9;
        const ang = Math.random() * Math.PI * 2, elv = Math.random() * 0.9;
        const spd = 10 + Math.random() * 22;
        s.vel.set(Math.cos(ang) * spd * Math.cos(elv), spd * Math.sin(elv) * 1.3, Math.sin(ang) * spd * Math.cos(elv));
        s.grav = 12;                              // heavy embers - arc down, don't float
        s.life = 1.8 + Math.random() * 1.6;       // the long tail
        if (Math.random() < 0.4) {s.life += 1;}   // stragglers land even later
      }
      this.h.spawnBurst(pos, { // dust column - the thermal updraft after the shell
        count: Math.floor(10 * mult), countMult: 1,
        elvBase: 0.1, elvSpan: Math.PI * 0.4,
        spdMin: 1, spdMax: 4, spdBoost: 1, vy: 6,
        lifeMin: 2.5, lifeVar: 1.5, lifeBoost: 1,
        sizeMin: 1.2 * mult, sizeVar: 0.8, sizeBoost: 1,
        gravity: -0.5,                            // nearly neutral - it drifts, not falls
        r1: 0.42, g1: 0.37, b1: 0.3, r2: 0.24, g2: 0.21, b2: 0.18,
        kind: 'smoke', stagger: 0.5, spin: 0.8,
      });
    }
    // Smoke scales DOWN at siege mult - at howitzer size count×mult was
    // 35 fat white sprites, the "huge clouds" that buried the blast. The
    // dust column already carries the big-blast aftermath; this heart
    // stays a dense core puff at any size.
    this.h.spawnBurst(pos, { // white smoke heart — the potassium sulfide signature (cut back count; smoke is the LONG tail, not the burst)
      count: 12, countMult: Math.min(mult, 1.2),
      elvBase: 0.4, elvSpan: Math.PI,
      spdMin: 1.5, spdMax: 7, spdBoost: 1, vy: 3,   // slower than the shock — smoke must not outpace the wavefront
      lifeMin: 1.2, lifeVar: 1, lifeBoost: 1,     // powder smoke lingers for seconds
      sizeMin: 0.5, sizeVar: 0.8, sizeBoost: 1,
      gravity: -2,
      r1: 0.88, g1: 0.86, b1: 0.82, r2: 0.45, g2: 0.44, b2: 0.42,
      kind: 'smoke', stagger: 0.08, spin: 1,
    });
    this.h.spawnBurst(pos, { // charcoal core smoke — darker breath inside
      count: 6, countMult: mult,
      elvBase: 0.3, elvSpan: Math.PI,
      spdMin: 3, spdMax: 9, spdBoost: 1, vy: 3,
      lifeMin: 0.4, lifeVar: 0.4, lifeBoost: 1,
      sizeMin: 0.35, sizeVar: 0.5, sizeBoost: 1,
      gravity: -3,
      r1: 0.32, g1: 0.3, b1: 0.28, r2: 0.15, g2: 0.14, b2: 0.13,
      kind: 'smoke', stagger: 0.07, spin: 1.4,
    });
    this.h.spawnBurst(pos, { // incandescent chips — the shell wall coming off hot (kept INSIDE the blast envelope — chips that fly past the AOE lie about the reach)
      count: 26, countMult: mult,
      elvBase: 0.5, elvSpan: Math.PI,
      spdMin: 18, spdMax: 40, spdBoost: 1, vy: 0,
      lifeMin: 0.2, lifeVar: 0.35, lifeBoost: 1,
      sizeMin: 0.06, sizeVar: 0.11, sizeBoost: 1,
      gravity: -30,
      r1: 1, g1: 0.65, g1Var: 0.2, b1: 0.25, r2: 0.6, g2: 0.2, b2: 0.05, kind: 'glow', stagger: 0.03,
    });
    // Iron sparks — sparse: the casing is iron, not magnesium
    for (let i = 0; i < Math.floor(6 * mult); i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.3) * Math.PI;
      const spd = 15 + Math.random() * 22;
      const spark = this.h.sparks.alloc(pos);
      spark.r = 1; spark.g = 0.75; spark.b = 0.4;
      spark.o = 0.55;
      spark.vel.set(spd * Math.cos(elv) * Math.sin(ang), spd * Math.sin(elv) + 6, spd * Math.cos(elv) * Math.cos(ang));
      spark.life = 0.3 + Math.random() * 0.2;
    }
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
      opacity: 1,
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
      r1: 0.3, g1: 0.28, b1: 0.26, r2: 0.1, g2: 0.1, b2: 0.1, kind: 'smoke', stagger: 0.1, spin: 1.2,
      planar: true,
    });
    // A few spark chips sell the shell-casing shred
    for (let i = 0; i < Math.floor(4 * mult); i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const spd = 30 + Math.random() * 40;
      const spark = this.h.sparks.alloc(pos);
      spark.r = 1; spark.g = 0.7; spark.b = 0.3;
      spark.o = 0.5;
      spark.vel.set(spd * Math.cos(elv) * Math.sin(ang), spd * Math.sin(elv), spd * Math.cos(elv) * Math.cos(ang));
      spark.life = 0.35 + Math.random() * 0.25;
    }
  }

  /** Electric spark helper — violet-white trails for energy/arc pops. */
  private electricSparks(pos: THREE.Vector3, mult: number): void {
    const count = Math.floor(6 * Math.min(mult, 2.5));
    for (let i = 0; i < count; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.3) * Math.PI * 0.7;
      const spd = 20 + Math.random() * 38;
      const spark = this.h.sparks.alloc(pos);
      if (this.h.hasTint) {
        _c.copy(this.h.tint).lerp(_c2.setRGB(1, 1, 1), 0.3 + Math.random() * 0.4);
        spark.r = _c.r; spark.g = _c.g; spark.b = _c.b;
      } else {
        spark.r = 0.7; spark.g = 0.85; spark.b = 1;
      }
      spark.o = 0.55;
      spark.vel.set(spd * Math.cos(elv) * Math.sin(ang), spd * Math.sin(elv) + 7, spd * Math.cos(elv) * Math.cos(ang));
      spark.life = 0.45 + Math.random() * 0.35;
    }
  }

  /** Splash — reads as LIQUID, not vapor. Two gas tells fixed here:
   *  additive glow sprites (light emission IS the gas look — aerated
   *  splash water is pale OPAQUE foam) and soft round puffs lingering
   *  (droplets are velocity-stretched streaks on a hard arc). Reference
   *  recipe: whitewater foam core + streaked crown + aerosol droplets
   *  + surface sheet; mist is a garnish, never a layer. */
  private splash(pos: THREE.Vector3, mult: number, directHit: boolean): void {
    const dh = directHit ? 1.25 : 1;
    // Energy core — it's a charged hose, not plain water: a hot lime
    // sphere that flashes fat and collapses inside ~0.25s, wrapped by a
    // fast shock shell. Reads as the charge that drove the splash.
    this.h.blastTinted(pos, {
      count: 3,
      elvBase: 0.5, elvSpan: Math.PI,   // tiny cones → near-spherical clump
      spdMin: 0.4, spdMax: 1.6, vy: 0.5,
      lifeMin: 0.12, lifeMax: 0.24,
      sizeMin: 2.2 * mult, sizeMax: 3.4 * mult,
      gravity: 0,
      c1: [0.9, 1, 0.55], c2: [0.3, 0.8, 0.1],
      opacity: 0.95,
    });
    this.h.allocShock(pos, 0xAA_FF_44, 0.22, 3.2 * mult, 0.65); // shell pops
    this.h.allocShock(pos, 0xEA_FF_AA, 0.14, 1.8 * mult, 0.8);  // hot inner rim
    this.h.spawnBurst(pos, { // whitewater — pale foam globs, NORMAL blend
      count: 12, countMult: mult,   // opaque-ish: foam scatters light back
      elvBase: 0.15, elvSpan: Math.PI * 0.45,
      spdMin: 2, spdMax: 10, spdBoost: dh, vy: 7,
      lifeMin: 0.3, lifeVar: 0.3, lifeBoost: dh,
      sizeMin: 0.3, sizeVar: 0.5, sizeBoost: dh,
      gravity: -42,
      r1: 0.92, g1: 1, b1: 0.82, r2: 0.5, g2: 0.78, b2: 0.38, kind: 'solid', stagger: 0.05, spin: 2,
    });
    blastBurst(pos, { // crown droplets — streaked, lit (not emissive)
      count: Math.floor(14 * mult),
      elvBase: 0.1, elvSpan: Math.PI * 0.5,
      spdMin: 3 * dh, spdMax: 13 * dh, vy: 6,
      lifeMin: 0.35 * dh, lifeMax: 0.7 * dh,
      sizeMin: 0.45 * dh, sizeMax: 0.9 * dh,
      gravity: -48, // water drops hard — a soft fall is what reads gassy
      c1: [0.9, 1, 0.75], c2: [0.4, 0.65, 0.2], // white foam → lime
      opacity: 0.95, stretched: true, stretchLen: 5, stagger: 0.06,
    }, false);
    blastBurst(pos, { // aerosol spray — many thin fast streaks
      count: Math.floor(24 * mult),
      elvBase: 0.15, elvSpan: Math.PI * 0.7,
      spdMin: 10 * dh, spdMax: 30 * dh, vy: 5,
      lifeMin: 0.14 * dh, lifeMax: 0.34 * dh,
      sizeMin: 0.12 * dh, sizeMax: 0.3 * dh,
      gravity: -52,
      c1: [0.85, 0.98, 0.68], c2: [0.35, 0.6, 0.18],
      opacity: 0.9, stretched: true, stretchLen: 7, stagger: 0.08,
    }, false);
    blastBurst(pos, { // surface sheet — droplets skimming outward
      count: Math.floor(9 * mult),
      planar: true, elvBase: 0, elvSpan: 0,
      spdMin: 7 * dh, spdMax: 18 * dh, vy: 1.2,
      lifeMin: 0.18 * dh, lifeMax: 0.36 * dh,
      sizeMin: 0.15 * dh, sizeMax: 0.4 * dh,
      gravity: -22,
      c1: [0.8, 0.95, 0.65], c2: [0.35, 0.6, 0.2],
      opacity: 0.85, stretched: true, stretchLen: 4, stagger: 0.06,
    }, false);
    this.h.blastTinted(pos, { // glints — a few HOT streaks ride on top;
      count: Math.floor(4 * mult), // specular pop is the only additive
      elvBase: 0.2, elvSpan: Math.PI * 0.5,  // water is allowed to keep
      spdMin: 8 * dh, spdMax: 22 * dh, vy: 6,
      lifeMin: 0.1 * dh, lifeMax: 0.2 * dh,
      sizeMin: 0.1, sizeMax: 0.2,
      gravity: -50,
      c1: [1, 1, 0.9], c2: [0.6, 0.9, 0.4],
      opacity: 1, stretched: true, stretchLen: 9, stagger: 0.04,
    });
    this.h.spawnBurst(pos, { // one breath of dew — a garnish, not fog
      count: 3, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 3, spdBoost: 1, vy: 1.5,
      lifeMin: 0.22, lifeVar: 0.18, lifeBoost: 1,
      sizeMin: 0.25, sizeVar: 0.3, sizeBoost: dh,
      gravity: -4,
      r1: 0.7, g1: 0.95, b1: 0.55, r2: 0.3, g2: 0.45, b2: 0.25, kind: 'smoke', stagger: 0.1, spin: 0.8,
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
      lifeMin: 0.6, lifeMax: 1,
      sizeMin: 1.25, sizeMax: 2,
      gravity: -25,
      c1: [0.6, 0.8, 1], c2: [0.2, 0.4, 0.8],
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
      c1: [0, 0.3, 1], c2: [0, 0, 0.4],
      opacity: 0.9, stagger: 0.1,
    });

    // Layers 8+9: Shockwave spheres — white expanding sphere, then blue
    for (const [color, life, maxRadius, opacity] of [
      [0xFF_FF_FF, 0.5, 10 * timeScale, 0.6],
      [0x00_CC_FF, 0.4, 12 * timeScale, 0.7],
    ] as const) {
      this.h.allocShock(pos, color, life, maxRadius, opacity);
    }

    // Layer 10: Sparks with trails — mix of orange and blue.
    for (let i = 0; i < Math.floor(18 * timeScale); i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI * 0.8;
      const spd = 15 + Math.random() * 30;
      const isBlue = Math.random() < 0.4;

      const spark = this.h.sparks.alloc(pos);
      spark.r = isBlue ? 0.1 : 1; spark.g = isBlue ? 0.4 : 0.8 + Math.random() * 0.2; spark.b = isBlue ? 1 : 0.3 + Math.random() * 0.3;
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
