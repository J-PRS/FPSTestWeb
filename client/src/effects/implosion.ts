import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import { Terrain } from '../world/terrain.js';

interface IP {
  mesh: THREE.Mesh | THREE.Sprite;
  mat: THREE.MeshBasicMaterial | THREE.SpriteMaterial;
  vx: number; vy: number; vz: number;
  life: number; elapsed: number;
  baseScale: number;
  gravity: number;
  r1: number; g1: number; b1: number;
  r2: number; g2: number; b2: number;
  dead: boolean;
  startDist: number;
  isSprite: boolean;
}

import { getGlowTexture as getGlowTex } from './glowTexture.js';
import { TerrainRing } from './TerrainRing.js';

// ---- Shared GPU resources (never disposed) ----
const GEO_SPHERE = new THREE.SphereGeometry(1, 5, 5);      // unit — scaled per particle
const GEO_SHOCK  = new THREE.SphereGeometry(0.3, 16, 16);
const GEO_CORE   = new THREE.SphereGeometry(1.2, 16, 16);
const ARC_SEGS   = 8;
const ARC_POINTS = ARC_SEGS + 1;

const _v = new THREE.Vector3();
const _c = new THREE.Color();

interface Arc {
  line: THREE.Line;
  life: number; elapsed: number; dead: boolean;
  basePts: Float32Array;              // ARC_POINTS*3 — spawn-time offsets from center
  posAttr: THREE.BufferAttribute;     // preallocated, rewritten per frame
  mat: THREE.LineBasicMaterial;
}

interface Shock { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; elapsed: number; maxRadius: number; dead: boolean }
interface Core  { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; dead: boolean }

// ---- Module pools — shared across all Implosion instances ----
const spritePool: IP[] = [];
const meshPool: IP[] = [];
const shockPool: Shock[] = [];
const corePool: Core[] = [];
const arcPool: Arc[] = [];

export class Implosion {
  dead = false;
  private particles: IP[] = [];
  private scene!: THREE.Scene;
  private elapsed = 0;
  private ox!: number; private oy!: number; private oz!: number;
  private shockwaves: Shock[] = [];
  private rings: TerrainRing[] = [];
  private core: Core | null = null;
  private arcs: Arc[] = [];

  constructor(scene: THREE.Scene, pos: THREE.Vector3, age: number = 0, terrain?: Terrain) {
    // See Explosion — hidden-tab spawns die at birth.
    if (typeof document !== 'undefined' && document.hidden) { this.dead = true; return; }
    this.scene = scene;
    this.ox = pos.x; this.oy = pos.y; this.oz = pos.z;

    // Scale factor based on projectile flight time: 50% at 0s, 100% at 1s (linear, clamped)
    const timeScale = Math.min(0.5 + age * 0.5, 1.0);

    // Layer 1: Outer ring - bright cyan, fast inward with spiral
    for (let i = 0; i < Math.floor(80 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 4 + Math.random() * 3;
      const spd = 25 + Math.random() * 15;
      this.spawn(pos, [dist, ang, elv, spd],
        [0.25 + Math.random()*0.15, 1.0 + Math.random()*0.4, 0.5],
        [0.8, 1.0, 1.0], [0.0, 0.5, 1.0], [true, true]);
    }

    // Layer 2: Inner ring - bright blue, medium inward with spiral
    for (let i = 0; i < Math.floor(60 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 2.5 + Math.random() * 2;
      const spd = 18 + Math.random() * 10;
      this.spawn(pos, [dist, ang, elv, spd],
        [0.30 + Math.random()*0.20, 0.9 + Math.random()*0.4, 0.5],
        [0.5, 0.8, 1.0], [0.0, 0.4, 0.8], [true, true]);
    }

    // Layer 3: Core flash - white, very fast inward with spiral
    for (let i = 0; i < Math.floor(30 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 1.5 + Math.random() * 1;
      const spd = 35 + Math.random() * 20;
      this.spawn(pos, [dist, ang, elv, spd],
        [0.12 + Math.random()*0.08, 0.8 + Math.random()*0.3, 0.5],
        [1.0, 1.0, 1.0], [0.8, 0.9, 1.0], [true, true]);
    }

    // Layer 4: Debris - solid chunks, inward
    for (let i = 0; i < Math.floor(40 * timeScale); i++) {
      const ang = Math.random() * Math.PI * 2;
      const elv = (Math.random() - 0.5) * Math.PI;
      const dist = 3 + Math.random() * 2.5;
      const spd = 15 + Math.random() * 12;
      this.spawn(pos, [dist, ang, elv, spd],
        [0.20 + Math.random()*0.15, 0.6 + Math.random()*0.2, 0.3],
        [0.3, 0.6, 0.5], [0.0, 0.2, 0.3], [false]);
    }

    // Layer 5: Shockwave - expanding cyan sphere
    let sw = shockPool.pop();
    if (sw) {
      this.scene.add(sw.mesh);
    } else {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, side: THREE.BackSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(GEO_SHOCK, mat);
      mesh.layers.enable(BLOOM_LAYER);
      this.scene.add(mesh);
      sw = { mesh, mat, life: 0, elapsed: 0, maxRadius: 0, dead: false };
    }
    sw.mat.color.setHex(0x00ffff).multiplyScalar(EMIT_GAIN);
    sw.mat.opacity = 0.8;
    sw.mesh.position.copy(pos);
    sw.life = 0.4; sw.elapsed = 0; sw.maxRadius = 8.0 * timeScale; sw.dead = false;
    this.shockwaves.push(sw);

    // Layer 5b: Terrain-draped expanding ground ring (+ ghost pass for
    // terrain-occluded arcs) — see TerrainRing
    this.rings.push(new TerrainRing(this.scene, pos, 0x66eeff, 0.5, 10.0 * timeScale, terrain));

    // Layer 6: Collapsing core - bright white sphere that shrinks
    let core = corePool.pop();
    if (core) {
      this.scene.add(core.mesh);
    } else {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(GEO_CORE, mat);
      mesh.layers.enable(BLOOM_LAYER);
      this.scene.add(mesh);
      core = { mesh, mat, dead: false };
    }
    core.mat.color.setHex(0xffffff).multiplyScalar(EMIT_GAIN);
    core.mat.opacity = 1.0;
    core.mesh.position.copy(pos);
    core.mesh.scale.setScalar(1);
    core.dead = false;
    this.core = core;

    // Layer 7: Electric arcs - lightning lines spiraling inward
    const arcCount = Math.floor(8 * timeScale);
    for (let i = 0; i < arcCount; i++) {
      const startRadius = 3 + Math.random() * 2;

      let arc = arcPool.pop();
      if (arc) {
        this.scene.add(arc.line);
      } else {
        const geo = new THREE.BufferGeometry();
        const posAttr = new THREE.BufferAttribute(new Float32Array(ARC_POINTS * 3), 3);
        posAttr.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('position', posAttr);
        const mat = new THREE.LineBasicMaterial({
          transparent: true, blending: THREE.AdditiveBlending,
        });
        const line = new THREE.Line(geo, mat);
        line.layers.enable(BLOOM_LAYER);
        line.frustumCulled = false;
        this.scene.add(line);
        arc = { line, life: 0, elapsed: 0, dead: false,
                basePts: new Float32Array(ARC_POINTS * 3), posAttr, mat };
      }
      // Store spawn-time point offsets relative to explosion center
      for (let j = 0; j < ARC_POINTS; j++) {
        const t = j / ARC_SEGS;
        const radius = startRadius * (1 - t);
        const angle = (Math.PI * 2 * i / arcCount) + t * Math.PI * 2 + Math.random() * 0.5;
        const elv = (Math.random() - 0.5) * 0.5;
        arc.basePts[j * 3]     = radius * Math.cos(elv) * Math.sin(angle);
        arc.basePts[j * 3 + 1] = radius * Math.sin(elv);
        arc.basePts[j * 3 + 2] = radius * Math.cos(elv) * Math.cos(angle);
      }
      arc.mat.color.setHex(0x88ffff).multiplyScalar(EMIT_GAIN);
      arc.mat.opacity = 0.8;
      arc.life = 0.3; arc.elapsed = 0; arc.dead = false;
      this.arcs.push(arc);
    }
  }

  private allocSprite(pos: THREE.Vector3, color: THREE.Color, opacity: number, additive: boolean): IP {
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
            r1: 0, g1: 0, b1: 0, r2: 0, g2: 0, b2: 0, dead: false, startDist: 0, isSprite: true };
    }
    const m = p.mat as THREE.SpriteMaterial;
    m.color.copy(color);
    m.opacity = opacity;
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.mesh.position.copy(pos);
    return p;
  }

  private allocMesh(pos: THREE.Vector3, color: THREE.Color): IP {
    let p = meshPool.pop();
    if (p) {
      this.scene.add(p.mesh);
    } else {
      const mat = new THREE.MeshBasicMaterial({ transparent: true });
      const mesh = new THREE.Mesh(GEO_SPHERE, mat);
      mesh.layers.enable(BLOOM_LAYER);
      this.scene.add(mesh);
      p = { mesh, mat, vx: 0, vy: 0, vz: 0, life: 0, elapsed: 0, baseScale: 1, gravity: 0,
            r1: 0, g1: 0, b1: 0, r2: 0, g2: 0, b2: 0, dead: false, startDist: 0, isSprite: false };
    }
    const m = p.mat;
    m.color.copy(color);
    m.opacity = 1.0;
    m.blending = THREE.NormalBlending;
    m.depthWrite = true;
    p.mesh.position.copy(pos);
    return p;
  }

  private spawn(
    pos: THREE.Vector3,
    [startDist, ang, elv, speed]: [number, number, number, number],
    [life, size, gravity]: [number, number, number],
    [r1, g1, b1]: [number, number, number],
    [r2, g2, b2]: [number, number, number],
    [additive, spiral = false]: [boolean, boolean?]
  ): void {
    // Start at outer radius
    const sx = pos.x + startDist * Math.cos(elv) * Math.sin(ang);
    const sy = pos.y + startDist * Math.sin(elv);
    const zpos = pos.z + startDist * Math.cos(elv) * Math.cos(ang);

    // Velocity points toward center
    let vx = -speed * Math.cos(elv) * Math.sin(ang);
    const vy = -speed * Math.sin(elv);
    let vz = -speed * Math.cos(elv) * Math.cos(ang);

    // Add spiral motion (tangential velocity)
    if (spiral) {
      const spiralSpeed = speed * 0.8;
      const tanX = Math.cos(elv) * Math.cos(ang);
      const tanZ = -Math.cos(elv) * Math.sin(ang);
      vx += tanX * spiralSpeed;
      vz += tanZ * spiralSpeed;
    }

    _v.set(sx, sy, zpos);
    _c.setRGB(r1, g1, b1);

    let p: IP;
    if (additive) {
      // Billboarded glow sprite — much bigger/brighter read than a tiny sphere
      p = this.allocSprite(_v, _c, 0.9, true);
      p.mesh.scale.setScalar(size * 3);
      p.baseScale = size * 3;
    } else {
      // Unit sphere scaled by size — no per-particle geometry
      p = this.allocMesh(_v, _c);
      p.baseScale = size;
    }
    Object.assign(p, { vx, vy, vz, life, elapsed: 0, gravity, r1, g1, b1, r2, g2, b2, dead: false, startDist });
    this.particles.push(p);
  }

  update(dt: number): void {
    this.elapsed += dt;
    let alive =
      this.updateParticles(dt) +
      this.updateCore() +
      this.updateShockwaves(dt) +
      this.updateArcs(dt);
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
      const t = p.elapsed / p.life;
      const ft = 1 - t;

      // Move inward
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;

      // Sprites keep most of their size and fade out; chunks shrink to a point
      const scl = p.isSprite
        ? p.baseScale * (0.5 + 0.5 * ft)
        : p.baseScale * ft;
      p.mesh.scale.setScalar(Math.max(scl, 0.01));

      // Color gradient — sprites (additive glow) write HDR-hot for bloom;
      // solid chunks keep display colors.
      const g = p.isSprite ? EMIT_GAIN : 1;
      p.mat.color.setRGB(
        (p.r1 + (p.r2 - p.r1) * t) * g,
        (p.g1 + (p.g2 - p.g1) * t) * g,
        (p.b1 + (p.b2 - p.b1) * t) * g,
      );
      p.mat.opacity = ft * (p.isSprite ? 0.9 : 1.0);
    }
    return alive;
  }

  private updateCore(): number {
    if (!this.core) return 0;
    const coreLife = 0.25;
    if (this.elapsed < coreLife) {
      const t = this.elapsed / coreLife;
      const scale = 1.0 - t;
      this.core.mesh.scale.setScalar(scale);
      this.core.mat.opacity = 1.0 - t * 0.5;
      return 1;
    }
    this.scene.remove(this.core.mesh);
    this.core.dead = true;
    corePool.push(this.core);
    this.core = null;
    return 0;
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
      sw.mesh.scale.setScalar(sw.maxRadius * t / 0.3);
      sw.mat.opacity = (1 - t) * 0.8;
    }
    return alive;
  }

  private updateArcs(dt: number): number {
    let alive = 0;
    for (const arc of this.arcs) {
      if (arc.dead) continue;
      arc.elapsed += dt;
      if (arc.elapsed >= arc.life) {
        this.scene.remove(arc.line);
        arc.dead = true;
        arcPool.push(arc);
        continue;
      }
      alive++;
      const t = arc.elapsed / arc.life;
      const ft = 1 - t;

      // Shrink arc points toward center — rewrite the preallocated attribute
      const arr = arc.posAttr.array as Float32Array;
      for (let i = 0; i < ARC_POINTS; i++) {
        arr[i * 3]     = this.ox + arc.basePts[i * 3] * ft;
        arr[i * 3 + 1] = this.oy + arc.basePts[i * 3 + 1] * ft;
        arr[i * 3 + 2] = this.oz + arc.basePts[i * 3 + 2] * ft;
      }
      arc.posAttr.needsUpdate = true;
      arc.mat.opacity = ft * 0.8;
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
    if (this.core && !this.core.dead) {
      this.scene.remove(this.core.mesh);
      this.core.dead = true;
      corePool.push(this.core);
    }
    for (const arc of this.arcs) {
      if (!arc.dead) {
        this.scene.remove(arc.line);
        arc.dead = true;
        arcPool.push(arc);
      }
    }
    this.particles = [];
    this.shockwaves = [];
    this.rings = [];
    this.arcs = [];
    this.core = null;
  }
}
