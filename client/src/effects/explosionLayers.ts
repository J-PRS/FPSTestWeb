import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import type { Terrain } from '../world/terrain.js';
import { TerrainRing } from './TerrainRing.js';
import { blastBurst, type BlastSpec } from './vfx.js';
import type { ExplosionSparks } from './explosionSparks.js';
import { BlastVariants, type BurstLayer, type VariantHost } from './blastVariants.js';
import { waterSplashAt } from './waterSplash.js';
import { markProbe } from '../core/fxDiag.js';

const layerOpacity = (kind: string): number => {
  if (kind === 'smoke') {return 0.55;}
  if (kind === 'glow') {return 0.9;}
  return 1;
};



// Per-weapon blast layer recipes - the spawn side of Explosion. Each
// variant returns true after laying its full recipe so the caller falls
// through to the shared powder blast only when no variant applies.
// Split from explosion.ts; owns the shock-dome pool and the ground
// rings alongside the spawn methods so update/dispose stay local.

interface Shockwave {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  elapsed: number;
  maxRadius: number;
  dead: boolean;
}

const GEO_SHOCK = new THREE.SphereGeometry(0.3, 16, 16); // shockwave shell
const shockPool: Shockwave[] = []; // module pool - shared across blasts
// Grow-only freelists held peak burst memory forever - pool a small warm
// floor and dispose the rest (each entry owns a MeshBasicMaterial).
const SHOCK_POOL_KEEP = 16;
function releaseShock(sw: Shockwave): void {
  if (shockPool.length >= SHOCK_POOL_KEEP) {sw.mat.dispose();}
  else {shockPool.push(sw);}
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();

export class ExplosionLayers implements VariantHost {
  private shockwaves: Shockwave[] = [];
  private rings: TerrainRing[] = [];
  private variants = new BlastVariants(this);

  constructor(
    private scene: THREE.Scene,
    readonly sparks: ExplosionSparks,
    readonly tint: THREE.Color,
    readonly hasTint: boolean,
  ) {}

  /** Lay the whole blast recipe - variant dispatch first, shared powder
   *  blast as the fallback. Caller finalizes the spark batch after. */
  spawn(vfx: string | undefined, pos: THREE.Vector3, mult: number,
        directHit: boolean, timeScale: number, terrain?: Terrain): void {
    if (!this.variants.spawn(vfx, pos, mult, directHit, timeScale, terrain)) {
      this.spawnFlash(pos, mult);
      this.spawnSpikes(pos, mult);
      this.spawnBaseLayers(pos, mult, directHit, vfx === 'concussion');
      this.spawnShockDome(pos, mult);   // every blast, not just direct hits
      this.spawnDebrisSparks(pos, mult); // ground impacts get sparks too
      if (directHit) {this.variants.directHitLayers(pos, timeScale);}
      this.spawnGroundRing(pos, mult, terrain);
    }
    // Any blast at the waterline throws a column - additive to the blast's
    // own recipe (a rocket at sea still booms AND splashes). 'splash'
    // blasts ARE water already - layering a sea column on a hose is spam.
    if (vfx !== 'splash') {waterSplashAt(pos, mult, terrain);}
  }

  // Layer 0: Instant flash - one giant white-hot sprite, gone in ~90ms.
  // The frame-zero flash is what reads as "something violent happened".
  spawnFlash(pos: THREE.Vector3, mult: number): void {
    _c.setHex(0xFF_F6_D8);
    if (this.hasTint) {_c.lerp(this.tint, 0.3);}
    // One batched particle, not a pooled sprite - a flash is a burst of 1.
    blastBurst(pos, {
      count: 1, spdMin: 0, spdMax: 0, vy: 0,
      lifeMin: 0.09, lifeMax: 0.09,
      sizeMin: 7 * mult, sizeMax: 7 * mult,
      gravity: 0,
      c1: [_c.r, _c.g, _c.b], c2: [1, 0.5, 0.2],
      opacity: 1,
    }, true);
  }

  // Layer 0b: Spike rays - thin stretched quads radiating out fast
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
  spawnBurst(pos: THREE.Vector3, l: BurstLayer): void {
    // One batched quarks burst instead of count pooled meshes/sprites -
    // the whole layer lands in a single draw call.
    let {r1} = l, {g1} = l, {b1} = l, {r2} = l, {g2} = l, {b2} = l;
    if (this.hasTint && l.kind === 'glow') {
      const k = 0.55;
      r1 += (this.tint.r - r1) * k; g1 += (this.tint.g - g1) * k; b1 += (this.tint.b - b1) * k;
      r2 += (this.tint.r - r2) * k; g2 += (this.tint.g - g2) * k; b2 += (this.tint.b - b2) * k;
    }
    // Billboard footprints the old mesh/sprite scales implied:
    // glow sprite 2.5×, smoke 4×, solid sphere ≈ 2×.
    let sMul = 2.5;
if (l.kind === 'smoke') {sMul = 4;}
else if (l.kind === 'solid') {sMul = 2;}
    blastBurst(pos, {
      count: Math.floor(l.count * l.countMult),
      elvBase: l.elvBase, elvSpan: l.elvSpan, planar: l.planar,
      spdMin: l.spdMin * l.spdBoost, spdMax: l.spdMax * l.spdBoost, vy: l.vy,
      lifeMin: l.lifeMin * l.lifeBoost, lifeMax: (l.lifeMin + l.lifeVar) * l.lifeBoost,
      sizeMin: l.sizeMin * l.sizeBoost * sMul, sizeMax: (l.sizeMin + l.sizeVar) * l.sizeBoost * sMul,
      gravity: l.gravity,
      c1: [r1, g1, b1], c2: [r2, g2, b2],
      opacity: layerOpacity(l.kind),
      gVar: l.g1Var,
      stagger: l.stagger,
      spin: l.spin,
    }, l.kind === 'glow');
  }

  private spawnBaseLayers(pos: THREE.Vector3, mult: number, directHit: boolean, heavy = false): void {
    const dh = directHit;
    const dhBoost = (v: number): number => (dh ? v : 1);
    const dhLife = dhBoost(1.4), dhSize = dhBoost(1.2);
    // 'heavy' (concussion: mortar/cannon/warhead) - slower, dirtier, more
    // smoke. HE reads as a thump with a black tail, not a clean fireball.
    const hv = heavy ? 1 : 0;

    // Layer 1: Flash - white-yellow, very short
    this.spawnBurst(pos, {
      count: 20, countMult: mult,
      elvBase: 0.4, elvSpan: Math.PI * 0.5,
      spdMin: 3, spdMax: 11, spdBoost: dhBoost(1.3), vy: 3,
      lifeMin: 0.16, lifeVar: 0.08, lifeBoost: dhLife,
      sizeMin: 1.8, sizeVar: 1.4, sizeBoost: dhSize,
      gravity: -3,
      r1: 1, g1: 1, b1: 0.85, r2: 1, g2: 0.6 - hv * 0.15, b2: 0, kind: 'glow',
    });

    // Layer 2: Fireball core - orange, additive (heavy burns redder)
    this.spawnBurst(pos, {
      count: 65, countMult: mult,
      elvBase: 0.25, elvSpan: Math.PI,
      spdMin: 7, spdMax: 35, spdBoost: dhBoost(1.4 - hv * 0.15), vy: 8,
      lifeMin: 0.4, lifeVar: 0.3, lifeBoost: dhBoost(1.5 + hv * 0.2),
      sizeMin: 0.35, sizeVar: 0.65, sizeBoost: dhBoost(1.3),
      gravity: -18 + hv * 4,
      r1: 1, g1: 0.4 - hv * 0.15, g1Var: 0.35, b1: 0, r2: 0.55 - hv * 0.1, g2: 0.02, b2: 0, kind: 'glow', stagger: 0.07,
    });

    // Layer 3: Debris - fast chunks; heavy HE throws dirt-brown shrapnel
    this.spawnBurst(pos, {
      count: 32 + Math.floor(hv * 14), countMult: mult,
      elvBase: 0.2, elvSpan: Math.PI * 0.75,
      spdMin: 16, spdMax: 56 - hv * 10, spdBoost: dhBoost(1.5), vy: 14 + hv * 4,
      lifeMin: 0.3, lifeVar: 0.35, lifeBoost: dhBoost(1.6 + hv * 0.3),
      sizeMin: 0.09, sizeVar: 0.15, sizeBoost: dhBoost(1.4),
      gravity: -32 - hv * 10,
      r1: 1 - hv * 0.55, g1: 0.3 - hv * 0.12, g1Var: 0.2, b1: 0, r2: 0.12, g2: 0.05, b2: 0.01, kind: 'solid', stagger: 0.1, spin: 5,
    });

    // Layer 4: Embers - tiny, long life
    this.spawnBurst(pos, {
      count: 80, countMult: mult,
      elvBase: 0.3, elvSpan: Math.PI,
      spdMin: 8, spdMax: 43, spdBoost: dhBoost(1.3), vy: 6,
      lifeMin: 0.7, lifeVar: 0.8, lifeBoost: dhLife,
      sizeMin: 0.05, sizeVar: 0.1, sizeBoost: dhSize,
      gravity: -14,
      r1: 1, g1: 0.5, g1Var: 0.3, b1: 0, r2: 0.2, g2: 0, b2: 0, kind: 'glow', stagger: 0.15,
    });

    // Layer 5: Smoke - dark billboards that linger and take over the tail
    // (the contrast that makes the fire read as fire, per Sakurai's recipe).
    // Heavy HE doubles it and drags it out - the dirt cloud is the tell.
    this.spawnBurst(pos, {
      count: 14 + Math.floor(hv * 12), countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 5 - hv * 1.5, spdBoost: 1, vy: 2.5 + hv,
      lifeMin: 1 + hv * 0.5, lifeVar: 0.6 + hv * 0.4, lifeBoost: dhBoost(1.3),
      sizeMin: 0.28 + hv * 0.1, sizeVar: 0.35 + hv * 0.15, sizeBoost: dhSize,
      gravity: -1,
      r1: 0.22 - hv * 0.08, g1: 0.2 - hv * 0.07, b1: 0.18 - hv * 0.06, r2: 0.06, g2: 0.06, b2: 0.06, kind: 'smoke', stagger: 0.12, spin: 1.4,
      planar: true,
    });

    // Layer 6 (heavy only): the HE signature - a dirt column mushrooming
    // up off the detonation point. Tight upward cone, slow rise, long
    // tail; the T2 mortar fountain, missing from the shared recipe.
    if (hv) {
      this.spawnBurst(pos, {
        count: 18, countMult: mult,
        elvBase: 1.15, elvSpan: Math.PI * 0.12,
        spdMin: 4, spdMax: 14, spdBoost: dhBoost(1.2), vy: 16,
        lifeMin: 1.4, lifeVar: 1, lifeBoost: dhLife,
        sizeMin: 0.5, sizeVar: 0.6, sizeBoost: dhSize,
        gravity: -0.8,
        r1: 0.3, g1: 0.22, b1: 0.14, r2: 0.08, g2: 0.07, b2: 0.06, kind: 'smoke', stagger: 0.18, spin: 1,
      });
    }
  }

  // Expanding shock dome on EVERY blast - previously direct-hit-only, which
  // is why ground-detonating weapons (mortar/GL/plasma) looked weak. Radius
  // scales with the weapon's real blast size (mult).
  private spawnShockDome(pos: THREE.Vector3, mult: number): void {
    this.allocShock(pos, 0xFF_FF_FF, 0.35, 5 * mult, 0.35);
    this.allocShock(pos, this.hasTint ? this.tint : 0xFF_CC_66, 0.45, 6.5 * mult, 0.5);
  }

  allocShock(pos: THREE.Vector3, color: number | THREE.Color, life: number, maxRadius: number, opacity: number, instant = false): void {
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
      markProbe(mesh, { kind: 'fxMesh', label: 'shockDome' });
      this.scene.add(mesh);
      sw = { mesh, mat, life, elapsed: 0, maxRadius, dead: false };
    }
    if (typeof color === 'number') {sw.mat.color.setHex(color);} else {sw.mat.color.copy(color);}
    sw.mat.color.multiplyScalar(EMIT_GAIN); // HDR-hot so bloom catches it
    sw.mat.opacity = opacity;
    sw.mesh.position.copy(pos);
    // Pooled meshes keep their last-frame scale - a reused dome at its
    // old full radius renders as a screen-swallowing sphere for one
    // frame before update() re-seats it. Reset at alloc.
    sw.mesh.scale.setScalar(0);
    sw.life = life;
    // instant: seed elapsed past the growth phase - the dome spawns at full
    // radius (instant AOE telegraph) and its whole life is the fade-out.
    sw.elapsed = instant ? life * 0.6 : 0;
    sw.maxRadius = maxRadius; sw.dead = false;
    this.shockwaves.push(sw);
  }

  // Trailing sparks for every blast - the debris streaks are most of what
  // makes a big explosion read as violent at distance. Kept sparse and
  // dim: at full strength they outshouted the fireball itself.
  private spawnDebrisSparks(pos: THREE.Vector3, mult: number): void {
    const count = Math.floor(8 * Math.min(mult, 2.5)); // cap count so mortar doesn't melt the pool
    for (let i = 0; i < count; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.3) * Math.PI * 0.7; // biased upward - ground blast
      const spd = 18 + Math.random() * 35;
      const spark = this.sparks.alloc(pos);
      if (this.hasTint) {
        _c.copy(this.tint).lerp(_c2.setRGB(1, 0.9, 0.6), Math.random() * 0.5);
        spark.r = _c.r; spark.g = _c.g; spark.b = _c.b;
      } else {
        spark.r = 1; spark.g = 0.6 + Math.random() * 0.3; spark.b = 0.2;
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

  spawnGroundRing(pos: THREE.Vector3, mult: number, terrain?: Terrain): void {
    this.rings.push(new TerrainRing(this.scene, pos, this.hasTint ? this.tint.getHex() : 0xFF_AA_33, 0.45, 9 * mult, terrain));
  }

  /** blastBurst with the weapon-energy tint applied to glow colors. */
  blastTinted(pos: THREE.Vector3, spec: BlastSpec): void {
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

  update(dt: number): number {
    let alive = this.updateShockwaves(dt);
    for (const r of this.rings) {if (r.update(dt)) {alive += 1;}}
    return alive;
  }

  private updateShockwaves(dt: number): number {
    let alive = 0;
    for (const sw of this.shockwaves) {
      if (sw.dead) {continue;}
      // Cap per-frame aging at 50ms: a spawn that lands on a hitch frame
      // (GC pause, tab-switch, queue drain) would otherwise age the dome
      // birth→death in ONE update - scale 0 straight to removed, the
      // "dome vanishes in a frame" glitch. Normal 60fps is unaffected.
      sw.elapsed += Math.min(dt, 0.05);
      if (sw.elapsed >= sw.life) {
        this.scene.remove(sw.mesh);
        sw.dead = true;
        releaseShock(sw);
        continue;
      }
alive += 1;
      const t = sw.elapsed / sw.life;
      // r ∝ t^0.4 - measured point-blast growth law (Trilithon): violent
      // off the mark, decelerating tail. Radius lands at ~60% of life and
      // HELD there - a dome that hits max size the instant it fades pops
      // out like a glitch; the last 40% is a linger-and-dissolve.
      const grow = Math.min(t / 0.6, 1);
      const ease = grow ** 0.4;
      sw.mesh.scale.setScalar(sw.maxRadius * ease / 0.3); // Scale from initial 0.3 radius
      sw.mat.opacity = (1 - t) * 0.8;
    }
    return alive;
  }

  dispose(): void {
    for (const sw of this.shockwaves) {
      if (!sw.dead) {
        this.scene.remove(sw.mesh);
        sw.dead = true;
        releaseShock(sw);
      }
    }
    for (const r of this.rings) {r.dispose();}
    this.shockwaves = [];
    this.rings = [];
  }
}
