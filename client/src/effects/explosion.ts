import * as THREE from 'three';
import { BLOOM_LAYER } from '../core/config.js';
import { Terrain } from '../world/terrain.js';

interface EP {
  mesh: THREE.Mesh | THREE.Sprite;
  mat: THREE.MeshBasicMaterial | THREE.SpriteMaterial;
  vx: number; vy: number; vz: number;
  life: number; elapsed: number;
  baseScale: number;
  gravity: number;
  r1: number; g1: number; b1: number;
  r2: number; g2: number; b2: number;
  dead: boolean;
  isSprite: boolean;
  baseOpacity: number;
  stretch?: number; // z-axis elongation multiplier (spike rays)
}

interface Shockwave {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  elapsed: number;
  maxRadius: number;
  dead: boolean;
}

import { getGlowTexture as getGlowTex } from './glowTexture.js';
import { TerrainRing } from './TerrainRing.js';

// ---- Shared GPU resources (never disposed) ----
const GEO_SPHERE = new THREE.SphereGeometry(1, 5, 5);      // unit — scaled per particle
const GEO_BOX    = new THREE.BoxGeometry(0.07, 0.07, 1);   // spike ray
const GEO_SHOCK  = new THREE.SphereGeometry(0.3, 16, 16);  // shockwave shell
const SPARK_TRAIL = 8;                                     // max trail points per spark

const _dir = new THREE.Vector3();

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
  line: THREE.Line;
  lineGeometry: THREE.BufferGeometry;
  posAttr: THREE.BufferAttribute;
  mat: THREE.LineBasicMaterial;
}

// ---- Module pools — shared across all Explosion instances ----
const spritePool: EP[] = [];
const meshPool: EP[] = [];
const shockPool: Shockwave[] = [];
const sparkPool: Spark[] = [];

export class Explosion {
  dead = false;
  private particles: EP[] = [];
  private shockwaves: Shockwave[] = [];
  private rings: TerrainRing[] = [];
  private sparks: Spark[] = [];
  private scene: THREE.Scene;
  private elapsed = 0;
  /** Immobile after construction — the blast's hearing surface for
   *  bot senses (mirrors the server's noise events). */
  readonly pos: THREE.Vector3;
  get age(): number { return this.elapsed; }
  private ox: number; private oy: number; private oz: number;
  // Per-weapon energy tint — lerped into glow particles, shock dome and
  // ground ring so a teal plasma bolt doesn't pop orange.
  private readonly tint = new THREE.Color();
  private hasTint = false;


  // sizeScale normalizes blast size to weapon radius (rocket = 1.0):
  // a mortar's 14m blast shouldn't render like a 6m rocket.
  constructor(scene: THREE.Scene, pos: THREE.Vector3, directHit: boolean = false, age: number = 0, ...opts: [terrain?: Terrain, sizeScale?: number, tint?: string | number, vfx?: 'splash' | 'punch']) {
    const [terrain, sizeScale = 1.0, tint, vfx] = opts;
    this.scene = scene;
    this.ox = pos.x; this.oy = pos.y; this.oz = pos.z;
    this.pos = pos.clone();
    if (tint !== undefined) {
      this.tint.set(tint);
      this.hasTint = true;
    }

    // Scale factor based on projectile flight time: 50% at 0s, 100% at 1s (linear, clamped)
    const timeScale = (directHit ? Math.min(0.5 + age * 0.5, 1.0) : 1.0) * sizeScale;
    // Multipliers for direct hit enhancement (base 1.8, scaled by time)
    const mult = (directHit ? 1.8 * timeScale : sizeScale);

    if (vfx === 'splash') {
      // Watery variant (sprinkler) — droplets + mist, no sparks/spikes/
      // shock dome: a hose splashes, it doesn't detonate.
      this.spawnFlash(pos, mult * 0.5);
      this.spawnSplashLayers(pos, mult, directHit);
      this.spawnGroundRing(pos, mult * 0.8, terrain);
      return;
    }

    if (vfx === 'punch') {
      // Melee swing — a fist isn't an ordnance event. Small dust puff +
      // a couple of streaks, ~0.2s, no flash sprite: the default recipe
      // point-blank to the camera is a self-flashbang every swing.
      this.spawnPunch(pos, mult);
      return;
    }

    this.spawnFlash(pos, mult);
    this.spawnSpikes(pos, mult);
    this.spawnBaseLayers(pos, mult, directHit);
    this.spawnShockDome(pos, mult);   // every blast, not just direct hits
    this.spawnDebrisSparks(pos, mult); // ground impacts get sparks too
    if (directHit) this.spawnDirectHitLayers(pos, timeScale);
    this.spawnGroundRing(pos, mult, terrain);
  }

  private allocSprite(pos: THREE.Vector3, color: THREE.Color, opacity: number, additive: boolean): EP {
    let p = spritePool.pop();
    if (p) {
      this.scene.add(p.mesh);
    } else {
      const mat = new THREE.SpriteMaterial({
        map: getGlowTex(), transparent: true, depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.layers.enable(BLOOM_LAYER);
      this.scene.add(sprite);
      p = { mesh: sprite, mat, vx: 0, vy: 0, vz: 0, life: 0, elapsed: 0, baseScale: 1, gravity: 0,
            r1: 0, g1: 0, b1: 0, r2: 0, g2: 0, b2: 0, dead: false, isSprite: true, baseOpacity: 1 };
    }
    const m = p.mat as THREE.SpriteMaterial;
    m.color.copy(color);
    m.opacity = opacity;
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.mesh.position.copy(pos);
    p.mesh.scale.setScalar(1);
    return p;
  }

  private allocMesh(geo: THREE.BufferGeometry, pos: THREE.Vector3, color: THREE.Color, opacity: number, additive: boolean, depthWrite: boolean): EP {
    let p = meshPool.pop();
    if (p) {
      p.mesh.geometry = geo;
      this.scene.add(p.mesh);
    } else {
      const mat = new THREE.MeshBasicMaterial({ transparent: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.layers.enable(BLOOM_LAYER);
      this.scene.add(mesh);
      p = { mesh, mat, vx: 0, vy: 0, vz: 0, life: 0, elapsed: 0, baseScale: 1, gravity: 0,
            r1: 0, g1: 0, b1: 0, r2: 0, g2: 0, b2: 0, dead: false, isSprite: false, baseOpacity: 1 };
    }
    const m = p.mat;
    m.color.copy(color);
    m.opacity = opacity;
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.depthWrite = depthWrite;
    p.mesh.position.copy(pos);
    p.mesh.scale.setScalar(1);
    p.stretch = undefined;
    return p;
  }

  // Layer 0: Instant flash — one giant white-hot sprite, gone in ~90ms.
  // The frame-zero flash is what reads as "something violent happened".
  private spawnFlash(pos: THREE.Vector3, mult: number): void {
    _c.setHex(0xfff6d8);
    if (this.hasTint) _c.lerp(this.tint, 0.3);
    const p = this.allocSprite(pos, _c, 1.0, true);
    p.mesh.scale.setScalar(7 * mult);
    Object.assign(p, { vx: 0, vy: 0, vz: 0, life: 0.09, elapsed: 0, baseScale: 7 * mult, gravity: 0,
      r1: 1, g1: 0.96, b1: 0.85, r2: 1, g2: 0.5, b2: 0.2, dead: false, baseOpacity: 1.0 });
    this.particles.push(p);
  }

  // Layer 0b: Spike rays — thin stretched quads radiating out fast
  // (Mega Man X / Metal Slug strength cue), additive, ~0.15s
  private spawnSpikes(pos: THREE.Vector3, mult: number): void {
    const spikeCount = Math.floor(8 * mult);
    for (let i = 0; i < spikeCount; i++) {
      const p = this.allocMesh(GEO_BOX, pos, _c.setHex(0xffcc55), 0.9, true, false);
      _dir.randomDirection();
      p.mesh.lookAt(_vA.copy(pos).add(_dir));
      p.mesh.scale.z = 3;
      const spd = 60 + Math.random() * 40;
      Object.assign(p, { vx: _dir.x * spd, vy: _dir.y * spd, vz: _dir.z * spd, life: 0.15, elapsed: 0,
        baseScale: 1.2, gravity: 0, r1: 1, g1: 0.8, b1: 0.33, r2: 0.4, g2: 0.4, b2: 0.05,
        dead: false, baseOpacity: 0.9, stretch: 14 });
      this.particles.push(p);
    }
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
  }): void {
    for (let i = 0; i < Math.floor(l.count * l.countMult); i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = l.spdMin + Math.random() * (l.spdMax - l.spdMin);
      const g1 = l.g1 + (l.g1Var ? Math.random() * l.g1Var : 0);
      const life = (l.lifeMin + Math.random() * l.lifeVar) * l.lifeBoost;
      const size = (l.sizeMin + Math.random() * l.sizeVar) * l.sizeBoost;
      if (l.planar) {
        this.spawn(pos,
          [spd * Math.sin(ang) + (Math.random() - 0.5), l.vy + Math.random() * 4, spd * Math.cos(ang) + (Math.random() - 0.5)],
          [life, size, l.gravity], [l.r1, g1, l.b1], [l.r2, l.g2, l.b2], l.kind);
      } else {
        const elv = (Math.random() - l.elvBase) * l.elvSpan;
        const v = spd * l.spdBoost;
        this.spawn(pos,
          [v * Math.cos(elv) * Math.sin(ang), v * Math.sin(elv) + l.vy, v * Math.cos(elv) * Math.cos(ang)],
          [life, size, l.gravity], [l.r1, g1, l.b1], [l.r2, l.g2, l.b2], l.kind);
      }
    }
  }

  private spawnBaseLayers(pos: THREE.Vector3, mult: number, directHit: boolean): void {
    const dh = directHit;
    const dhBoost = (v: number) => (dh ? v : 1.0);
    const dhLife = dhBoost(1.4), dhSize = dhBoost(1.2);

    // Layer 1: Flash — white-yellow, very short
    this.spawnBurst(pos, {
      count: 20, countMult: mult,
      elvBase: 0.4, elvSpan: Math.PI * 0.5,
      spdMin: 3, spdMax: 11, spdBoost: dhBoost(1.3), vy: 3,
      lifeMin: 0.16, lifeVar: 0.08, lifeBoost: dhLife,
      sizeMin: 1.8, sizeVar: 1.4, sizeBoost: dhSize,
      gravity: -3,
      r1: 1, g1: 1, b1: 0.85, r2: 1, g2: 0.6, b2: 0, kind: 'glow',
    });

    // Layer 2: Fireball core — orange, additive
    this.spawnBurst(pos, {
      count: 65, countMult: mult,
      elvBase: 0.25, elvSpan: Math.PI,
      spdMin: 7, spdMax: 35, spdBoost: dhBoost(1.4), vy: 8,
      lifeMin: 0.40, lifeVar: 0.30, lifeBoost: dhBoost(1.5),
      sizeMin: 0.35, sizeVar: 0.65, sizeBoost: dhBoost(1.3),
      gravity: -18,
      r1: 1, g1: 0.4, g1Var: 0.35, b1: 0, r2: 0.55, g2: 0.02, b2: 0, kind: 'glow',
    });

    // Layer 3: Debris — fast chunks, orange→brown, solid
    this.spawnBurst(pos, {
      count: 32, countMult: mult,
      elvBase: 0.2, elvSpan: Math.PI * 0.75,
      spdMin: 16, spdMax: 56, spdBoost: dhBoost(1.5), vy: 14,
      lifeMin: 0.30, lifeVar: 0.35, lifeBoost: dhBoost(1.6),
      sizeMin: 0.09, sizeVar: 0.15, sizeBoost: dhBoost(1.4),
      gravity: -32,
      r1: 1, g1: 0.3, g1Var: 0.2, b1: 0, r2: 0.12, g2: 0.05, b2: 0.01, kind: 'solid',
    });

    // Layer 4: Embers — tiny, long life
    this.spawnBurst(pos, {
      count: 80, countMult: mult,
      elvBase: 0.3, elvSpan: Math.PI,
      spdMin: 8, spdMax: 43, spdBoost: dhBoost(1.3), vy: 6,
      lifeMin: 0.7, lifeVar: 0.8, lifeBoost: dhLife,
      sizeMin: 0.05, sizeVar: 0.10, sizeBoost: dhSize,
      gravity: -14,
      r1: 1, g1: 0.5, g1Var: 0.3, b1: 0, r2: 0.2, g2: 0, b2: 0, kind: 'glow',
    });

    // Layer 5: Smoke — dark billboards that linger and take over the tail
    // (the contrast that makes the fire read as fire, per Sakurai's recipe)
    this.spawnBurst(pos, {
      count: 14, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 5, spdBoost: 1, vy: 2.5,
      lifeMin: 1.0, lifeVar: 0.6, lifeBoost: dhBoost(1.3),
      sizeMin: 0.28, sizeVar: 0.35, sizeBoost: dhSize,
      gravity: -1,
      r1: 0.22, g1: 0.20, b1: 0.18, r2: 0.06, g2: 0.06, b2: 0.06, kind: 'smoke',
      planar: true,
    });
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
      r1: 0.7, g1: 1.0, b1: 0.4, r2: 0.25, g2: 0.55, b2: 0.12, kind: 'glow',
    });
    this.spawnBurst(pos, { // fine spray — many small fast droplets
      count: 22, countMult: mult,
      elvBase: 0.15, elvSpan: Math.PI * 0.7,
      spdMin: 8, spdMax: 26, spdBoost: dh, vy: 5,
      lifeMin: 0.2, lifeVar: 0.25, lifeBoost: dh,
      sizeMin: 0.05, sizeVar: 0.1, sizeBoost: dh,
      gravity: -34,
      r1: 0.6, g1: 1.0, b1: 0.35, r2: 0.2, g2: 0.5, b2: 0.1, kind: 'glow',
    });
    this.spawnBurst(pos, { // mist — pale puffs that linger a beat
      count: 6, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 4, spdBoost: 1, vy: 1.8,
      lifeMin: 0.5, lifeVar: 0.4, lifeBoost: 1,
      sizeMin: 0.3, sizeVar: 0.35, sizeBoost: dh,
      gravity: -3,
      r1: 0.7, g1: 0.95, b1: 0.55, r2: 0.3, g2: 0.45, b2: 0.25, kind: 'smoke',
      planar: true,
    });
    this.spawnBurst(pos, { // ground sheet — droplets skimming outward
      count: 9, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 6, spdMax: 17, spdBoost: dh, vy: 1.2,
      lifeMin: 0.22, lifeVar: 0.2, lifeBoost: dh,
      sizeMin: 0.08, sizeVar: 0.14, sizeBoost: dh,
      gravity: -18,
      r1: 0.65, g1: 1.0, b1: 0.4, r2: 0.25, g2: 0.55, b2: 0.12, kind: 'glow',
      planar: true,
    });
  }

  /** Punch puff — melee impact cue. A few short streaks + a dust puff,
   *  ~0.2s. No flash sprite, no sparks: a fist isn't an ordnance event,
   *  and anything brighter point-blank reads as a self-flashbang. */
  private spawnPunch(pos: THREE.Vector3, mult: number): void {
    for (let i = 0; i < Math.floor(4 * mult); i++) {
      const p = this.allocMesh(GEO_BOX, pos, _c.setHex(0xbfd4e0), 0.55, true, false);
      _dir.randomDirection();
      p.mesh.lookAt(_vA.copy(pos).add(_dir));
      const spd = 10 + Math.random() * 12;
      Object.assign(p, { vx: _dir.x * spd, vy: _dir.y * spd, vz: _dir.z * spd,
        life: 0.12, elapsed: 0, baseScale: 0.5, gravity: 0,
        r1: 0.75, g1: 0.83, b1: 0.88, r2: 0.3, g2: 0.35, b2: 0.4,
        dead: false, baseOpacity: 0.55, stretch: 8 });
      this.particles.push(p);
    }
    this.spawnBurst(pos, { // dust puff — a handful of soft billboards
      count: 6, countMult: mult,
      elvBase: 0, elvSpan: 0,
      spdMin: 1, spdMax: 4, spdBoost: 1, vy: 1.5,
      lifeMin: 0.2, lifeVar: 0.15, lifeBoost: 1,
      sizeMin: 0.15, sizeVar: 0.2, sizeBoost: 1,
      gravity: -2,
      r1: 0.6, g1: 0.65, b1: 0.7, r2: 0.3, g2: 0.33, b2: 0.36, kind: 'smoke',
      planar: true,
    });
  }

  private spawnDirectHitLayers(pos: THREE.Vector3, timeScale: number): void {
    // Layer 6: Direct hit bonus — extra bright white core particles
    for (let i = 0; i < Math.floor(60 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const spd = 20 + Math.random() * 50;
      this.spawn(pos,
        [spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+10, spd*Math.cos(elv)*Math.cos(ang)],
        [0.6 + Math.random()*0.4, 0.5 + Math.random()*0.3, -25],
        [0.6, 0.8, 1.0], [0.2, 0.4, 0.8], 'glow');
    }

    // Layer 7: Blue energy burst — identifies direct hits by color
    for (let i = 0; i < Math.floor(70 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const spd = 12 + Math.random() * 35;
      this.spawn(pos,
        [spd*Math.cos(elv)*Math.sin(ang), spd*Math.sin(elv)+8, spd*Math.cos(elv)*Math.cos(ang)],
        [0.5 + Math.random()*0.4, 0.3 + Math.random()*0.25, -10],
        [0.0, 0.3, 1.0], [0.0, 0.0, 0.4], 'glow');
    }

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
      spark.mat.color.setRGB(isBlue ? 0.1 : 1.0, isBlue ? 0.4 : 0.8 + Math.random() * 0.2, isBlue ? 1.0 : 0.3 + Math.random() * 0.3);
      spark.mat.opacity = 0.55;
      spark.vel.set(
        spd * Math.cos(elv) * Math.sin(ang),
        spd * Math.sin(elv) + 5,
        spd * Math.cos(elv) * Math.cos(ang)
      );
      spark.life = 1.5 + Math.random() * 0.5;
    }
  }

  // Pooled spark: pop a live line from the pool, or build the line+ring
  // buffer once. Callers set color/vel/life.
  private allocSpark(pos: THREE.Vector3): Spark {
    let spark = sparkPool.pop();
    if (spark) {
      this.scene.add(spark.line);
      spark.posAttr.needsUpdate = true;
    } else {
      const lineGeometry = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(new Float32Array(SPARK_TRAIL * 3), 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      lineGeometry.setAttribute('position', posAttr);
      lineGeometry.setDrawRange(0, 0);
      const mat = new THREE.LineBasicMaterial({
        transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(lineGeometry, mat);
      line.layers.enable(BLOOM_LAYER);
      line.frustumCulled = false;
      this.scene.add(line);
      spark = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, elapsed: 0, dead: false,
        trailBuf: new Float32Array(SPARK_TRAIL * 3), trailHead: 0, trailCount: 0,
        line, lineGeometry, posAttr, mat };
    }
    spark.pos.copy(pos);
    spark.life = 0; spark.elapsed = 0; spark.dead = false;
    spark.trailHead = 0; spark.trailCount = 0;
    spark.lineGeometry.setDrawRange(0, 0);
    this.sparks.push(spark);
    return spark;
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
        spark.mat.color.copy(this.tint).lerp(_c.setRGB(1, 0.9, 0.6), Math.random() * 0.5);
      } else {
        spark.mat.color.setRGB(1.0, 0.6 + Math.random() * 0.3, 0.2);
      }
      spark.mat.opacity = 0.5;
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

  private spawn(
    pos: THREE.Vector3,
    [vx, vy, vz]: [number, number, number],
    [life, sz, gravity]: [number, number, number],
    [r1, g1, b1]: [number, number, number],
    [r2, g2, b2]: [number, number, number],
    kind: 'glow' | 'solid' | 'smoke'
  ): void {
    if (this.hasTint && kind === 'glow') {
      // Lerp the fire palette toward the weapon's energy color
      const k = 0.55;
      r1 += (this.tint.r - r1) * k; g1 += (this.tint.g - g1) * k; b1 += (this.tint.b - b1) * k;
      r2 += (this.tint.r - r2) * k; g2 += (this.tint.g - g2) * k; b2 += (this.tint.b - b2) * k;
    }
    const px = pos.x + (Math.random()-0.5)*0.5;
    const py = pos.y + (Math.random()-0.5)*0.5;
    const pz = pos.z + (Math.random()-0.5)*0.5;
    _vA.set(px, py, pz);
    _c.setRGB(r1, g1, b1);

    let p: EP;
    if (kind !== 'solid') {
      // Billboarded sprite — soft round particle visible from every angle.
      // 'glow' = additive fire; 'smoke' = normal-blended dark puff for contrast.
      p = this.allocSprite(_vA, _c, kind === 'glow' ? 0.9 : 0.55, kind === 'glow');
      const s = kind === 'smoke' ? sz * 4 : sz * 2.5;
      p.mesh.scale.setScalar(s);
      p.baseScale = s;
    } else {
      // Unit sphere scaled by sz — no per-particle geometry
      p = this.allocMesh(GEO_SPHERE, _vA, _c, 1.0, false, true);
      p.baseScale = sz;
    }
    Object.assign(p, { vx, vy, vz, life, elapsed: 0, gravity, r1, g1, b1, r2, g2, b2, dead: false });
    this.particles.push(p);
  }

  update(dt: number): void {
    this.elapsed += dt;
    let alive =
      this.updateParticles(dt) +
      this.updateShockwaves(dt) +
      this.updateSparks(dt);
    for (const r of this.rings) if (r.update(dt)) alive++;

    if (alive === 0) this.dead = true;
  }

  private updateParticles(dt: number): number {
    let alive = 0;
    for (const p of this.particles) {
      if (p.dead) continue;
      p.elapsed += dt;
      if (p.elapsed >= p.life) {
        this.scene.remove(p.mesh);
        p.dead = true;
        if (p.isSprite) spritePool.push(p); else meshPool.push(p);
        continue;
      }
      alive++;
      const t  = p.elapsed / p.life;
      const ft = 1 - t;
      p.vy += p.gravity * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      // grow briefly then shrink
      const scl = p.baseScale * (t < 0.12 ? t / 0.12 : ft);
      if (p.stretch) {
        p.mesh.scale.set(Math.max(scl, 0.01), Math.max(scl, 0.01), Math.max(scl * p.stretch, 0.01));
      } else {
        p.mesh.scale.setScalar(Math.max(scl, 0.01));
      }
      p.mat.color.setRGB(
        p.r1 + (p.r2 - p.r1) * t,
        p.g1 + (p.g2 - p.g1) * t,
        p.b1 + (p.b2 - p.b1) * t,
      );
      p.mat.opacity = ft * p.baseOpacity;
    }
    return alive;
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
    for (const spark of this.sparks) {
      if (spark.dead) continue;
      spark.elapsed += dt;
      if (spark.elapsed >= spark.life) {
        this.scene.remove(spark.line);
        spark.dead = true;
        sparkPool.push(spark);
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

      // Write ordered positions into the preallocated geometry attribute
      if (spark.trailCount >= 2) {
        const arr = spark.posAttr.array as Float32Array;
        for (let i = 0; i < spark.trailCount; i++) {
          const s = (spark.trailHead - spark.trailCount + i + SPARK_TRAIL) % SPARK_TRAIL;
          arr[i * 3] = tb[s * 3];
          arr[i * 3 + 1] = tb[s * 3 + 1];
          arr[i * 3 + 2] = tb[s * 3 + 2];
        }
        spark.lineGeometry.setDrawRange(0, spark.trailCount);
        spark.posAttr.needsUpdate = true;
      }

      // Fade out
      const t = spark.elapsed / spark.life;
      spark.mat.opacity = (1 - t) * 0.8;
    }
    return alive;
  }

  dispose(): void {
    for (const p of this.particles) {
      if (!p.dead) {
        this.scene.remove(p.mesh);
        p.dead = true;
        if (p.isSprite) spritePool.push(p); else meshPool.push(p);
      }
    }
    for (const sw of this.shockwaves) {
      if (!sw.dead) {
        this.scene.remove(sw.mesh);
        sw.dead = true;
        shockPool.push(sw);
      }
    }
    for (const r of this.rings) r.dispose();
    for (const spark of this.sparks) {
      if (!spark.dead) {
        this.scene.remove(spark.line);
        spark.dead = true;
        sparkPool.push(spark);
      }
    }
    this.particles = [];
    this.shockwaves = [];
    this.rings = [];
    this.sparks = [];
  }
}

const _c = new THREE.Color();
const _vA = new THREE.Vector3();
