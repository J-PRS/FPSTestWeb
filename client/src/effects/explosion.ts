import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import { Terrain } from '../world/terrain.js';

interface Shockwave {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  elapsed: number;
  maxRadius: number;
  dead: boolean;
}

import { TerrainRing } from './TerrainRing.js';
import { blastBurst, type BlastSpec } from './vfx.js';

// ---- Shared GPU resources (never disposed) ----
const GEO_SHOCK  = new THREE.SphereGeometry(0.3, 16, 16);  // shockwave shell
const SPARK_TRAIL = 8;                                     // max trail points per spark

interface Spark {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  elapsed: number;
  dead: boolean;
  // Fixed ring buffer of trail points — no Vector3 array churn
  trailBuf: Float32Array; // SPARK_TRAIL * 3
  trailHead: number;
  trailCount: number;
  // Base color + opacity — the shared vertex-color attribute fades by
  // writing color*(1-t)*o each frame (additive blending: black = gone).
  r: number; g: number; b: number; o: number;
  slice: number; // float offset into the shared position/color arrays
}

// Trail polyline → segment pairs: SPARK_TRAIL points make TRAIL-1
// segments = 14 verts = 42 floats per spark in the shared buffer.
const SPARK_FLOATS = (SPARK_TRAIL - 1) * 2 * 3;

// ---- Module pools — shared across all Explosion instances ----
const shockPool: Shockwave[] = [];

export class Explosion {
  dead = false;
  private shockwaves: Shockwave[] = [];
  private rings: TerrainRing[] = [];
  private sparks: Spark[] = [];
  private scene!: THREE.Scene;
  private elapsed = 0;
  /** Immobile after construction — the blast's hearing surface for
   *  bot senses (mirrors the server's noise events). */
  readonly pos!: THREE.Vector3;
  get age(): number { return this.elapsed; }
  private ox!: number; private oy!: number; private oz!: number;
  // Per-weapon energy tint — lerped into glow particles, shock dome and
  // ground ring so a teal plasma bolt doesn't pop orange.
  private readonly tint = new THREE.Color();
  private hasTint = false;


  // sizeScale normalizes blast size to weapon radius (rocket = 1.0):
  // a mortar's 14m blast shouldn't render like a 6m rocket.
  constructor(scene: THREE.Scene, pos: THREE.Vector3, directHit: boolean = false, age: number = 0, ...opts: [terrain?: Terrain, sizeScale?: number, tint?: string | number, vfx?: 'splash' | 'punch' | 'energy' | 'kinetic' | 'concussion' | 'arc']) {
    const [terrain, sizeScale = 1.0, tint, vfx] = opts;
    // pos/scene must always bind — bot senses read .pos for blast
    // hearing even on a dead-at-birth shell.
    this.scene = scene;
    this.ox = pos.x; this.oy = pos.y; this.oz = pos.z;
    this.pos = pos.clone();
    // Hidden tabs decay ~1 frame/sec — spawning full VFX there stacks
    // hundreds of live particles into the frame you tab back to.
    if (typeof document !== 'undefined' && document.hidden) { this.dead = true; return; }
    if (tint !== undefined) {
      this.tint.set(tint);
      this.hasTint = true;
    }

    // Scale factor based on projectile flight time: 50% at 0s, 100% at 1s (linear, clamped)
    const timeScale = (directHit ? Math.min(0.5 + age * 0.5, 1.0) : 1.0) * sizeScale;
    // Multipliers for direct hit enhancement (base 1.8, scaled by time)
    const mult = (directHit ? 1.8 * timeScale : sizeScale);

    if (this.spawnVariant(vfx, pos, mult, directHit, timeScale, terrain)) return;

    this.spawnFlash(pos, mult);
    this.spawnSpikes(pos, mult);
    this.spawnBaseLayers(pos, mult, directHit, vfx === 'concussion');
    this.spawnShockDome(pos, mult);   // every blast, not just direct hits
    this.spawnDebrisSparks(pos, mult); // ground impacts get sparks too
    if (directHit) this.spawnDirectHitLayers(pos, timeScale);
    this.spawnGroundRing(pos, mult, terrain);
    this.finalizeSparks();
  }

  /** Per-weapon VFX variants — each returns true after spawning its full
   *  recipe so the constructor falls through to the shared powder blast
   *  only when no variant applies. */
  private spawnVariant(vfx: string | undefined, pos: THREE.Vector3, mult: number,
      directHit: boolean, timeScale: number, terrain?: Terrain): boolean {
    if (vfx === 'splash') {
      // Watery variant (sprinkler) — droplets + mist, no sparks/spikes/
      // shock dome: a hose splashes, it doesn't detonate.
      this.spawnFlash(pos, mult * 0.5);
      this.spawnSplashLayers(pos, mult, directHit);
      this.spawnGroundRing(pos, mult * 0.8, terrain);
      return true;
    }
    if (vfx === 'punch') {
      // Melee swing — a fist isn't an ordnance event. Small dust puff +
      // a couple of streaks, ~0.2s, no flash sprite: the default recipe
      // point-blank to the camera is a self-flashbang every swing.
      this.spawnPunch(pos, mult);
      return true;
    }
    if (vfx === 'energy') {
      // Spinfusor/plasma family — an energy discharge, not a powder blast:
      // crisp tinted flash, tight glow core, electric spikes, and the
      // signature hard ring. NO debris chunks or lingering smoke — energy
      // dissipates, it doesn't smolder.
      this.spawnFlash(pos, mult * 0.9);
      this.spawnEnergyLayers(pos, mult, directHit);
      this.spawnShockDome(pos, mult * 0.8);
      this.spawnElectricSparks(pos, mult);
      if (directHit) this.spawnDirectHitLayers(pos, timeScale);
      this.spawnGroundRing(pos, mult * 1.2, terrain); // wider, brighter — the ring IS the read
      this.finalizeSparks();
      return true;
    }
    if (vfx === 'kinetic') {
      // Railgun slug / javelin — a kinetic strike: hard pin-flash + a fan
      // of speedlines + dust. No fireball, no dome — it punctures,
      // it doesn't detonate.
      this.spawnKineticLayers(pos, mult);
      this.spawnGroundRing(pos, mult * 0.6, terrain);
      this.finalizeSparks();
      return true;
    }
    if (vfx === 'arc') {
      // Lightning pop — a capacitor dumping: thin fast spikes + a small
      // hot core + arc sparks. No dome, no smoke.
      this.spawnFlash(pos, mult * 0.6);
      this.spawnArcLayers(pos, mult);
      this.spawnElectricSparks(pos, mult);
      this.finalizeSparks();
      return true;
    }
    return false;
  }

  // Layer 0: Instant flash — one giant white-hot sprite, gone in ~90ms.
  // The frame-zero flash is what reads as "something violent happened".
  private spawnFlash(pos: THREE.Vector3, mult: number): void {
    _c.setHex(0xfff6d8);
    if (this.hasTint) _c.lerp(this.tint, 0.3);
    // One batched particle, not a pooled sprite — a flash is a burst of 1.
    blastBurst(pos, {
      count: 1, spdMin: 0, spdMax: 0, vy: 0,
      lifeMin: 0.09, lifeMax: 0.09,
      sizeMin: 7 * mult, sizeMax: 7 * mult,
      gravity: 0,
      c1: [_c.r, _c.g, _c.b], c2: [1, 0.5, 0.2],
      opacity: 1.0,
    }, true);
  }

  // Layer 0b: Spike rays — thin stretched quads radiating out fast
  // (Mega Man X / Metal Slug strength cue), additive, ~0.15s. Quarks
  // StretchedBillBoard does the velocity-stretch on the batch, so all
  // rays land in the shared draw call instead of a mesh each.
  private spawnSpikes(pos: THREE.Vector3, mult: number): void {
    blastBurst(pos, {
      count: Math.floor(8 * mult),
      elvBase: 0.5, elvSpan: Math.PI,
      spdMin: 60, spdMax: 100, vy: 0,
      lifeMin: 0.15, lifeMax: 0.15,
      sizeMin: 0.25, sizeMax: 0.25, // thin across; length comes from stretch
      gravity: 0,
      c1: [1, 0.8, 0.33], c2: [0.4, 0.4, 0.05],
      opacity: 0.9,
      stretched: true, stretchLen: 14,
    }, true);
  }

  // One particle layer: `count` (scaled by mult) particles on a randomized
  // cone, with per-particle jittered life/size and a color gradient.
  private spawnBurst(pos: THREE.Vector3, l: {
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
  }): void {
    // One batched quarks burst instead of count pooled meshes/sprites —
    // the whole layer lands in a single draw call.
    let r1 = l.r1, g1 = l.g1, b1 = l.b1, r2 = l.r2, g2 = l.g2, b2 = l.b2;
    if (this.hasTint && l.kind === 'glow') {
      const k = 0.55;
      r1 += (this.tint.r - r1) * k; g1 += (this.tint.g - g1) * k; b1 += (this.tint.b - b1) * k;
      r2 += (this.tint.r - r2) * k; g2 += (this.tint.g - g2) * k; b2 += (this.tint.b - b2) * k;
    }
    // Billboard footprints the old mesh/sprite scales implied:
    // glow sprite 2.5×, smoke 4×, solid sphere ≈ 2×.
    const sMul = l.kind === 'smoke' ? 4 : l.kind === 'solid' ? 2 : 2.5;
    blastBurst(pos, {
      count: Math.floor(l.count * l.countMult),
      elvBase: l.elvBase, elvSpan: l.elvSpan, planar: l.planar,
      spdMin: l.spdMin * l.spdBoost, spdMax: l.spdMax * l.spdBoost, vy: l.vy,
      lifeMin: l.lifeMin * l.lifeBoost, lifeMax: (l.lifeMin + l.lifeVar) * l.lifeBoost,
      sizeMin: l.sizeMin * l.sizeBoost * sMul, sizeMax: (l.sizeMin + l.sizeVar) * l.sizeBoost * sMul,
      gravity: l.gravity,
      c1: [r1, g1, b1], c2: [r2, g2, b2],
      opacity: l.kind === 'glow' ? 0.9 : l.kind === 'smoke' ? 0.55 : 1,
      gVar: l.g1Var,
      stagger: l.stagger,
      spin: l.spin,
    }, l.kind === 'glow');
  }

  private spawnBaseLayers(pos: THREE.Vector3, mult: number, directHit: boolean, heavy = false): void {
    const dh = directHit;
    const dhBoost = (v: number) => (dh ? v : 1.0);
    const dhLife = dhBoost(1.4), dhSize = dhBoost(1.2);
    // 'heavy' (concussion: mortar/cannon/warhead) — slower, dirtier, more
    // smoke. HE reads as a thump with a black tail, not a clean fireball.
    const hv = heavy ? 1.0 : 0.0;

    // Layer 1: Flash — white-yellow, very short
    this.spawnBurst(pos, {
      count: 20, countMult: mult,
      elvBase: 0.4, elvSpan: Math.PI * 0.5,
      spdMin: 3, spdMax: 11, spdBoost: dhBoost(1.3), vy: 3,
      lifeMin: 0.16, lifeVar: 0.08, lifeBoost: dhLife,
      sizeMin: 1.8, sizeVar: 1.4, sizeBoost: dhSize,
      gravity: -3,
      r1: 1, g1: 1, b1: 0.85, r2: 1, g2: 0.6 - hv * 0.15, b2: 0, kind: 'glow',
    });

    // Layer 2: Fireball core — orange, additive (heavy burns redder)
    this.spawnBurst(pos, {
      count: 65, countMult: mult,
      elvBase: 0.25, elvSpan: Math.PI,
      spdMin: 7, spdMax: 35, spdBoost: dhBoost(1.4 - hv * 0.15), vy: 8,
      lifeMin: 0.40, lifeVar: 0.30, lifeBoost: dhBoost(1.5 + hv * 0.2),
      sizeMin: 0.35, sizeVar: 0.65, sizeBoost: dhBoost(1.3),
      gravity: -18 + hv * 4,
      r1: 1, g1: 0.4 - hv * 0.15, g1Var: 0.35, b1: 0, r2: 0.55 - hv * 0.1, g2: 0.02, b2: 0, kind: 'glow', stagger: 0.07,
    });

    // Layer 3: Debris — fast chunks; heavy HE throws dirt-brown shrapnel
    this.spawnBurst(pos, {
      count: 32 + Math.floor(hv * 14), countMult: mult,
      elvBase: 0.2, elvSpan: Math.PI * 0.75,
      spdMin: 16, spdMax: 56 - hv * 10, spdBoost: dhBoost(1.5), vy: 14 + hv * 4,
      lifeMin: 0.30, lifeVar: 0.35, lifeBoost: dhBoost(1.6 + hv * 0.3),
      sizeMin: 0.09, sizeVar: 0.15, sizeBoost: dhBoost(1.4),
      gravity: -32 - hv * 10,
      r1: 1 - hv * 0.55, g1: 0.3 - hv * 0.12, g1Var: 0.2, b1: 0, r2: 0.12, g2: 0.05, b2: 0.01, kind: 'solid', stagger: 0.10, spin: 5,
    });

    // Layer 4: Embers — tiny, long life
    this.spawnBurst(pos, {
      count: 80, countMult: mult,
      elvBase: 0.3, elvSpan: Math.PI,
      spdMin: 8, spdMax: 43, spdBoost: dhBoost(1.3), vy: 6,
      lifeMin: 0.7, lifeVar: 0.8, lifeBoost: dhLife,
      sizeMin: 0.05, sizeVar: 0.10, sizeBoost: dhSize,
      gravity: -14,
      r1: 1, g1: 0.5, g1Var: 0.3, b1: 0, r2: 0.2, g2: 0, b2: 0, kind: 'glow', stagger: 0.15,
    });

    // Layer 5: Smoke — dark billboards that linger and take over the tail
    // (the contrast that makes the fire read as fire, per Sakurai's recipe).
    // Heavy HE doubles it and drags it out — the dirt cloud is the tell.
    this.spawnBurst(pos, {
      count: 14 + Math.floor(hv * 12), countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 5 - hv * 1.5, spdBoost: 1, vy: 2.5 + hv,
      lifeMin: 1.0 + hv * 0.5, lifeVar: 0.6 + hv * 0.4, lifeBoost: dhBoost(1.3),
      sizeMin: 0.28 + hv * 0.1, sizeVar: 0.35 + hv * 0.15, sizeBoost: dhSize,
      gravity: -1,
      r1: 0.22 - hv * 0.08, g1: 0.20 - hv * 0.07, b1: 0.18 - hv * 0.06, r2: 0.06, g2: 0.06, b2: 0.06, kind: 'smoke', stagger: 0.12, spin: 1.4,
      planar: true,
    });
  }

  /** Energy layers — spinfusor/plasma: a compact white-hot core wrapped in
   *  the weapon tint, one hard spike fan, and zero smolder. Everything
   *  decays in <0.5s — the hit should read as a SNAP, not a fire. */
  private spawnEnergyLayers(pos: THREE.Vector3, mult: number, directHit: boolean): void {
    const dh = directHit ? 1.2 : 1.0;
    this.spawnBurst(pos, { // hot core — white center bleeding to tint
      count: 34, countMult: mult,
      elvBase: 0.3, elvSpan: Math.PI,
      spdMin: 6, spdMax: 30, spdBoost: dh, vy: 4,
      lifeMin: 0.22, lifeVar: 0.18, lifeBoost: dh,
      sizeMin: 0.4, sizeVar: 0.6, sizeBoost: dh,
      gravity: -6,
      r1: 1, g1: 1, b1: 1, r2: 0.4, g2: 0.4, b2: 0.5, kind: 'glow', stagger: 0.06,
    });
    this.blastTinted(pos, { // tint shell — the colored halo around the core
      count: Math.floor(26 * mult),
      elvBase: 0.2, elvSpan: Math.PI * 0.8,
      spdMin: 10, spdMax: 42, vy: 5,
      lifeMin: 0.3, lifeMax: 0.5,
      sizeMin: 0.5, sizeMax: 1.0,
      gravity: -8,
      c1: [0.8, 0.9, 1.0], c2: [0.2, 0.3, 0.5],
      opacity: 0.85, stagger: 0.08,
    });
    this.blastTinted(pos, { // spike fan — thin fast energy streaks
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
    this.spawnBurst(pos, { // lingering motes — the only "tail" energy gets
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
  private spawnKineticLayers(pos: THREE.Vector3, mult: number): void {
    blastBurst(pos, { // pin flash — small, very hot, very brief
      count: 1, spdMin: 0, spdMax: 0, vy: 0,
      lifeMin: 0.08, lifeMax: 0.08,
      sizeMin: 4 * mult, sizeMax: 4 * mult,
      gravity: 0,
      c1: [1, 1, 1], c2: [0.7, 0.8, 1.0],
      opacity: 1.0,
    }, true);
    this.blastTinted(pos, { // speedline fan — the whole silhouette
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
    this.spawnBurst(pos, { // impact dust — soft kicked debris
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
      const spark = this.allocSpark(pos);
      spark.r = 1.0; spark.g = 0.85; spark.b = 0.5;
      spark.o = 0.6;
      spark.vel.set(spd * Math.cos(elv) * Math.sin(ang), spd * Math.sin(elv) + 8, spd * Math.cos(elv) * Math.cos(ang));
      spark.life = 0.4 + Math.random() * 0.3;
    }
  }

  /** Arc pop — a lightning discharge: thin violet-white spikes + a small
   *  sizzling core. Reads as electricity, not ordnance. */
  private spawnArcLayers(pos: THREE.Vector3, mult: number): void {
    this.blastTinted(pos, { // jagged spikes — the discharge arcs
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
    this.spawnBurst(pos, { // sizzle core — small, hot, brief
      count: 12, countMult: mult,
      elvBase: 0.3, elvSpan: Math.PI,
      spdMin: 4, spdMax: 18, spdBoost: 1, vy: 3,
      lifeMin: 0.15, lifeVar: 0.15, lifeBoost: 1,
      sizeMin: 0.25, sizeVar: 0.35, sizeBoost: 1,
      gravity: -4,
      r1: 0.85, g1: 0.95, b1: 1, r2: 0.3, g2: 0.4, b2: 0.9, kind: 'glow', stagger: 0.05,
    });
  }

  /** Electric spark helper — violet-white trails for energy/arc pops. */
  private spawnElectricSparks(pos: THREE.Vector3, mult: number): void {
    const count = Math.floor(6 * Math.min(mult, 2.5));
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.3) * Math.PI * 0.7;
      const spd = 20 + Math.random() * 38;
      const spark = this.allocSpark(pos);
      if (this.hasTint) {
        _c.copy(this.tint).lerp(_c2.setRGB(1, 1, 1), 0.3 + Math.random() * 0.4);
        spark.r = _c.r; spark.g = _c.g; spark.b = _c.b;
      } else {
        spark.r = 0.7; spark.g = 0.85; spark.b = 1.0;
      }
      spark.o = 0.55;
      spark.vel.set(spd * Math.cos(elv) * Math.sin(ang), spd * Math.sin(elv) + 7, spd * Math.cos(elv) * Math.cos(ang));
      spark.life = 0.45 + Math.random() * 0.35;
    }
  }

  /** Splash layers — a lime burst that reads as liquid, not fire:
   *  crown droplets lobbed up and rained down, a fast fine spray, slow
   *  pale mist puffs, and a low sheet skimming the surface. Deliberately
   *  cheap — the hose pops at ~9/s. */
  private spawnSplashLayers(pos: THREE.Vector3, mult: number, directHit: boolean): void {
    const dh = directHit ? 1.25 : 1.0;
    this.spawnBurst(pos, { // crown — fat droplets arced skyward
      count: 14, countMult: mult,
      elvBase: 0.1, elvSpan: Math.PI * 0.5,
      spdMin: 3, spdMax: 13, spdBoost: dh, vy: 6,
      lifeMin: 0.45, lifeVar: 0.4, lifeBoost: dh,
      sizeMin: 0.22, sizeVar: 0.4, sizeBoost: dh,
      gravity: -30,
      r1: 0.7, g1: 1.0, b1: 0.4, r2: 0.25, g2: 0.55, b2: 0.12, kind: 'glow', stagger: 0.08, spin: 2,
    });
    this.spawnBurst(pos, { // fine spray — many small fast droplets
      count: 22, countMult: mult,
      elvBase: 0.15, elvSpan: Math.PI * 0.7,
      spdMin: 8, spdMax: 26, spdBoost: dh, vy: 5,
      lifeMin: 0.2, lifeVar: 0.25, lifeBoost: dh,
      sizeMin: 0.05, sizeVar: 0.1, sizeBoost: dh,
      gravity: -34,
      r1: 0.6, g1: 1.0, b1: 0.35, r2: 0.2, g2: 0.5, b2: 0.1, kind: 'glow', stagger: 0.10, spin: 2.5,
    });
    this.spawnBurst(pos, { // mist — pale puffs that linger a beat
      count: 6, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 4, spdBoost: 1, vy: 1.8,
      lifeMin: 0.5, lifeVar: 0.4, lifeBoost: 1,
      sizeMin: 0.3, sizeVar: 0.35, sizeBoost: dh,
      gravity: -3,
      r1: 0.7, g1: 0.95, b1: 0.55, r2: 0.3, g2: 0.45, b2: 0.25, kind: 'smoke', stagger: 0.15, spin: 0.8,
      planar: true,
    });
    this.spawnBurst(pos, { // ground sheet — droplets skimming outward
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
  private spawnPunch(pos: THREE.Vector3, mult: number): void {
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
    this.spawnBurst(pos, { // dust puff — a handful of soft billboards
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

  private spawnDirectHitLayers(pos: THREE.Vector3, timeScale: number): void {
    // Layer 6: Direct hit bonus — extra bright white core particles
    this.blastTinted(pos, {
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
    this.blastTinted(pos, {
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
      this.allocShock(pos, color, life, maxRadius, opacity);
    }

    // Layer 10: Sparks with trails — mix of orange and blue. Sparse: the
    // direct-hit bonus is already three layers of glow + twin domes.
    for (let i = 0; i < Math.floor(18 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI * 0.8;
      const spd = 15 + Math.random() * 30;
      const isBlue = Math.random() < 0.4;

      const spark = this.allocSpark(pos);
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

  // Sparks are plain data now — finalizeSparks() bakes them into ONE
  // LineSegments per explosion after construction (~40 sparks → 1 draw
  // call where each used to be its own Line + geometry + material).
  private sparkMesh: THREE.LineSegments | null = null;
  private sparkPosAttr: THREE.BufferAttribute | null = null;
  private sparkColAttr: THREE.BufferAttribute | null = null;

  private allocSpark(pos: THREE.Vector3): Spark {
    const spark: Spark = {
      pos: pos.clone(), vel: new THREE.Vector3(), life: 0, elapsed: 0, dead: false,
      trailBuf: new Float32Array(SPARK_TRAIL * 3), trailHead: 0, trailCount: 0,
      r: 1, g: 1, b: 1, o: 0.8, slice: 0,
    };
    this.sparks.push(spark);
    return spark;
  }

  private finalizeSparks(): void {
    const n = this.sparks.length;
    if (!n) return;
    const geo = new THREE.BufferGeometry();
    this.sparkPosAttr = new THREE.BufferAttribute(new Float32Array(n * SPARK_FLOATS), 3);
    this.sparkColAttr = new THREE.BufferAttribute(new Float32Array(n * SPARK_FLOATS), 3);
    this.sparkPosAttr.setUsage(THREE.DynamicDrawUsage);
    this.sparkColAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.sparkPosAttr);
    geo.setAttribute('color', this.sparkColAttr);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
    });
    this.sparkMesh = new THREE.LineSegments(geo, mat);
    this.sparkMesh.layers.enable(BLOOM_LAYER);
    this.sparkMesh.frustumCulled = false;
    this.scene.add(this.sparkMesh);
    for (let i = 0; i < n; i++) this.sparks[i].slice = i * SPARK_FLOATS;
  }

  // Expanding shock dome on EVERY blast — previously direct-hit-only, which
  // is why ground-detonating weapons (mortar/GL/plasma) looked weak. Radius
  // scales with the weapon's real blast size (mult).
  private spawnShockDome(pos: THREE.Vector3, mult: number): void {
    this.allocShock(pos, 0xffffff, 0.35, 5.0 * mult, 0.35);
    this.allocShock(pos, this.hasTint ? this.tint : 0xffcc66, 0.45, 6.5 * mult, 0.5);
  }

  private allocShock(pos: THREE.Vector3, color: number | THREE.Color, life: number, maxRadius: number, opacity: number): void {
    let sw = shockPool.pop();
    if (sw) {
      sw.mesh.geometry = GEO_SHOCK;
      this.scene.add(sw.mesh);
    } else {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, side: THREE.BackSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(GEO_SHOCK, mat);
      mesh.layers.enable(BLOOM_LAYER);
      this.scene.add(mesh);
      sw = { mesh, mat, life, elapsed: 0, maxRadius, dead: false };
    }
    if (typeof color === 'number') sw.mat.color.setHex(color); else sw.mat.color.copy(color);
    sw.mat.color.multiplyScalar(EMIT_GAIN); // HDR-hot so bloom catches it
    sw.mat.opacity = opacity;
    sw.mesh.position.copy(pos);
    sw.life = life; sw.elapsed = 0; sw.maxRadius = maxRadius; sw.dead = false;
    this.shockwaves.push(sw);
  }

  // Trailing sparks for every blast — the debris streaks are most of what
  // makes a big explosion read as violent at distance. Kept sparse and
  // dim: at full strength they outshouted the fireball itself.
  private spawnDebrisSparks(pos: THREE.Vector3, mult: number): void {
    const count = Math.floor(8 * Math.min(mult, 2.5)); // cap count so mortar doesn't melt the pool
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.3) * Math.PI * 0.7; // biased upward — ground blast
      const spd = 18 + Math.random() * 35;
      const spark = this.allocSpark(pos);
      if (this.hasTint) {
        _c.copy(this.tint).lerp(_c2.setRGB(1, 0.9, 0.6), Math.random() * 0.5);
        spark.r = _c.r; spark.g = _c.g; spark.b = _c.b;
      } else {
        spark.r = 1.0; spark.g = 0.6 + Math.random() * 0.3; spark.b = 0.2;
      }
      spark.o = 0.5;
      spark.vel.set(
        spd * Math.cos(elv) * Math.sin(ang),
        spd * Math.sin(elv) + 6,
        spd * Math.cos(elv) * Math.cos(ang)
      );
      spark.life = 0.5 + Math.random() * 0.4;
    }
  }

  private spawnGroundRing(pos: THREE.Vector3, mult: number, terrain?: Terrain): void {
    this.rings.push(new TerrainRing(this.scene, pos, this.hasTint ? this.tint.getHex() : 0xffaa33, 0.45, 9.0 * mult, terrain));
  }

  /** blastBurst with the weapon-energy tint applied to glow colors. */
  private blastTinted(pos: THREE.Vector3, spec: BlastSpec): void {
    if (this.hasTint) {
      const k = 0.55;
      spec.c1 = [spec.c1[0] + (this.tint.r - spec.c1[0]) * k,
                 spec.c1[1] + (this.tint.g - spec.c1[1]) * k,
                 spec.c1[2] + (this.tint.b - spec.c1[2]) * k];
      spec.c2 = [spec.c2[0] + (this.tint.r - spec.c2[0]) * k,
                 spec.c2[1] + (this.tint.g - spec.c2[1]) * k,
                 spec.c2[2] + (this.tint.b - spec.c2[2]) * k];
    }
    blastBurst(pos, spec, true);
  }

  update(dt: number): void {
    this.elapsed += dt;
    let alive =
      this.updateShockwaves(dt) +
      this.updateSparks(dt);
    for (const r of this.rings) if (r.update(dt)) alive++;

    if (alive === 0) this.dead = true;
  }

  private updateShockwaves(dt: number): number {
    let alive = 0;
    for (const sw of this.shockwaves) {
      if (sw.dead) continue;
      sw.elapsed += dt;
      if (sw.elapsed >= sw.life) {
        this.scene.remove(sw.mesh);
        sw.dead = true;
        shockPool.push(sw);
        continue;
      }
      alive++;
      const t = sw.elapsed / sw.life;
      sw.mesh.scale.setScalar(sw.maxRadius * t / 0.3); // Scale from initial 0.3 radius
      sw.mat.opacity = (1 - t) * 0.8;
    }
    return alive;
  }

  private updateSparks(dt: number): number {
    let alive = 0;
    const posArr = this.sparkPosAttr?.array as Float32Array | undefined;
    const colArr = this.sparkColAttr?.array as Float32Array | undefined;
    for (const spark of this.sparks) {
      if (spark.dead) continue;
      spark.elapsed += dt;
      if (spark.elapsed >= spark.life) {
        spark.dead = true;
        // Collapse the slice — degenerate segments rasterize nothing.
        if (posArr) posArr.fill(0, spark.slice, spark.slice + SPARK_FLOATS);
        continue;
      }
      alive++;

      // Apply gravity
      spark.vel.y -= 40 * dt;

      // Update position
      spark.pos.addScaledVector(spark.vel, dt);

      // Push into trail ring buffer
      const tb = spark.trailBuf;
      const h = spark.trailHead;
      tb[h * 3] = spark.pos.x; tb[h * 3 + 1] = spark.pos.y; tb[h * 3 + 2] = spark.pos.z;
      spark.trailHead = (h + 1) % SPARK_TRAIL;
      if (spark.trailCount < SPARK_TRAIL) spark.trailCount++;

      if (posArr && colArr) this.writeSparkSlice(spark, posArr, colArr);
    }
    if (alive && this.sparkPosAttr && this.sparkColAttr) {
      this.sparkPosAttr.needsUpdate = true;
      this.sparkColAttr.needsUpdate = true;
    }
    return alive;
  }

  // Write this spark's trail slice: oldest→newest segment pairs, tail
  // dims toward the oldest point. Fade lives in vertex color — additive
  // blending makes black invisible, so color*(1-t)*o replaces the old
  // per-Line material opacity.
  private writeSparkSlice(spark: Spark, posArr: Float32Array, colArr: Float32Array): void {
    const f = (1 - spark.elapsed / spark.life) * spark.o * EMIT_GAIN;
    const cr = spark.r * f, cg = spark.g * f, cb = spark.b * f;
    const tb = spark.trailBuf;
    let w = spark.slice;
    const n = spark.trailCount;
    for (let i = 0; i < SPARK_TRAIL - 1; i++) {
      if (i < n - 1) {
        const s0 = (spark.trailHead - n + i + SPARK_TRAIL) % SPARK_TRAIL;
        const s1 = (s0 + 1) % SPARK_TRAIL;
        posArr[w] = tb[s0 * 3]; posArr[w + 1] = tb[s0 * 3 + 1]; posArr[w + 2] = tb[s0 * 3 + 2];
        posArr[w + 3] = tb[s1 * 3]; posArr[w + 4] = tb[s1 * 3 + 1]; posArr[w + 5] = tb[s1 * 3 + 2];
        const tail = 0.35 + 0.65 * (i / Math.max(1, n - 1));
        colArr[w] = cr * tail; colArr[w + 1] = cg * tail; colArr[w + 2] = cb * tail;
        colArr[w + 3] = cr; colArr[w + 4] = cg; colArr[w + 5] = cb;
      } else {
        posArr.fill(0, w, w + 6);
        colArr.fill(0, w, w + 6);
      }
      w += 6;
    }
  }

  dispose(): void {
    for (const sw of this.shockwaves) {
      if (!sw.dead) {
        this.scene.remove(sw.mesh);
        sw.dead = true;
        shockPool.push(sw);
      }
    }
    for (const r of this.rings) r.dispose();
    if (this.sparkMesh) {
      this.scene.remove(this.sparkMesh);
      this.sparkMesh.geometry.dispose();
      (this.sparkMesh.material as THREE.Material).dispose();
      this.sparkMesh = null;
      this.sparkPosAttr = null;
      this.sparkColAttr = null;
    }
    this.shockwaves = [];
    this.rings = [];
    this.sparks = [];
  }
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();
