import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import type { Terrain } from '../world/terrain.js';

import { TerrainRing } from './TerrainRing.js';
import { implodeBurst } from './vfx.js';
import { markProbe } from '../core/fxDiag.js';

// ---- Shared GPU resources (never disposed) ----
const GEO_SHOCK  = new THREE.SphereGeometry(0.3, 16, 16);
const GEO_CORE   = new THREE.SphereGeometry(1.2, 16, 16);
const ARC_SEGS   = 8;
const ARC_POINTS = ARC_SEGS + 1;



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
const shockPool: Shock[] = [];
const corePool: Core[] = [];
const arcPool: Arc[] = [];
// Grow-only freelists held peak-blast memory forever — keep a small warm
// floor per kind and dispose the overflow (each entry owns a material;
// arc also owns its line geometry).
const SHOCK_POOL_KEEP = 8;
const CORE_POOL_KEEP = 4;
const ARC_POOL_KEEP = 16;
function releaseShock(sw: Shock): void {
  if (shockPool.length >= SHOCK_POOL_KEEP) {sw.mat.dispose();}
  else {shockPool.push(sw);}
}
function releaseCore(c: Core): void {
  if (corePool.length >= CORE_POOL_KEEP) {c.mat.dispose();}
  else {corePool.push(c);}
}
function releaseArc(a: Arc): void {
  if (arcPool.length >= ARC_POOL_KEEP) { a.mat.dispose(); a.line.geometry.dispose(); }
  else {arcPool.push(a);}
}

export class Implosion {
  dead = false;
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
    const timeScale = Math.min(0.5 + age * 0.5, 1);

    // Layers 1-3: glow rings converging inward — one batched burst each
    // (the old path spawned 170 individually-drawn sprites/meshes per
    // implosion). Swirl ≈ 0.8·avgSpeed reproduces the spiral term.
    implodeBurst(pos, { // outer ring — bright cyan, fast, biggest shell
      count: 80 * timeScale, rMin: 4, rMax: 7, spdMin: 25, spdMax: 40, swirl: 26,
      lifeMin: 0.25, lifeMax: 0.4, sizeMin: 3, sizeMax: 4.2,
      c1: [0.8, 1, 1], c2: [0, 0.5, 1], opacity: 0.9, stagger: 0.08,
    }, true);
    implodeBurst(pos, { // inner ring — blue, tighter, slower
      count: 60 * timeScale, rMin: 2.5, rMax: 4.5, spdMin: 18, spdMax: 28, swirl: 18,
      lifeMin: 0.3, lifeMax: 0.5, sizeMin: 2.7, sizeMax: 3.7,
      c1: [0.5, 0.8, 1], c2: [0, 0.4, 0.8], opacity: 0.9, stagger: 0.08,
    }, true);
    implodeBurst(pos, { // core flash — white, very fast, small shell
      count: 30 * timeScale, rMin: 1.5, rMax: 2.5, spdMin: 35, spdMax: 55, swirl: 36,
      lifeMin: 0.12, lifeMax: 0.2, sizeMin: 2.4, sizeMax: 3.9,
      c1: [1, 1, 1], c2: [0.8, 0.9, 1], opacity: 0.9,
    }, true);
    implodeBurst(pos, { // debris chunks — solid, inward, no spiral
      count: 40 * timeScale, rMin: 3, rMax: 5.5, spdMin: 15, spdMax: 27,
      lifeMin: 0.2, lifeMax: 0.35, sizeMin: 0.6, sizeMax: 1.2,
      c1: [0.3, 0.6, 0.5], c2: [0, 0.2, 0.3], opacity: 1, spin: 4, stagger: 0.08,
    }, false);

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
      markProbe(mesh, { kind: 'fxMesh', label: 'implosion:shock' });
      this.scene.add(mesh);
      sw = { mesh, mat, life: 0, elapsed: 0, maxRadius: 0, dead: false };
    }
    sw.mat.color.setHex(0x00FFFF).multiplyScalar(EMIT_GAIN);
    sw.mat.opacity = 0.8;
    sw.mesh.position.copy(pos);
    sw.life = 0.4; sw.elapsed = 0; sw.maxRadius = 8 * timeScale; sw.dead = false;
    this.shockwaves.push(sw);

    // Layer 5b: Terrain-draped expanding ground ring — see TerrainRing
    this.rings.push(new TerrainRing(this.scene, pos, 0x66_ee_ff, 0.5, 10 * timeScale, terrain));

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
      markProbe(mesh, { kind: 'fxMesh', label: 'implosion:core' });
      this.scene.add(mesh);
      core = { mesh, mat, dead: false };
    }
    core.mat.color.setHex(0xff_ff_ff).multiplyScalar(EMIT_GAIN);
    core.mat.opacity = 1;
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
        markProbe(line, { kind: 'fxMesh', label: 'implosion:arc' });
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
      arc.mat.color.setHex(0x88FFFF).multiplyScalar(EMIT_GAIN);
      arc.mat.opacity = 0.8;
      arc.life = 0.3; arc.elapsed = 0; arc.dead = false;
      this.arcs.push(arc);
    }
  }

  update(dt: number): void {
    this.elapsed += dt;
    let alive =
      this.updateCore() +
      this.updateShockwaves(dt) +
      this.updateArcs(dt);
    for (const r of this.rings) {if (r.update(dt)) {alive++;}}
    if (alive === 0) {this.dead = true;}
  }

  private updateCore(): number {
    if (!this.core) {return 0;}
    const coreLife = 0.25;
    if (this.elapsed < coreLife) {
      const t = this.elapsed / coreLife;
      const scale = 1 - t;
      this.core.mesh.scale.setScalar(scale);
      this.core.mat.opacity = 1 - t * 0.5;
      return 1;
    }
    this.scene.remove(this.core.mesh);
    this.core.dead = true;
    releaseCore(this.core);
    this.core = null;
    return 0;
  }

  private updateShockwaves(dt: number): number {
    let alive = 0;
    for (const sw of this.shockwaves) {
      if (sw.dead) {continue;}
      sw.elapsed += dt;
      if (sw.elapsed >= sw.life) {
        this.scene.remove(sw.mesh);
        sw.dead = true;
        releaseShock(sw);
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
      if (arc.dead) {continue;}
      arc.elapsed += dt;
      if (arc.elapsed >= arc.life) {
        this.scene.remove(arc.line);
        arc.dead = true;
        releaseArc(arc);
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
    for (const sw of this.shockwaves) {
      if (!sw.dead) {
        this.scene.remove(sw.mesh);
        sw.dead = true;
        releaseShock(sw);
      }
    }
    for (const r of this.rings) {r.dispose();}
    if (this.core && !this.core.dead) {
      this.scene.remove(this.core.mesh);
      this.core.dead = true;
      releaseCore(this.core);
    }
    for (const arc of this.arcs) {
      if (!arc.dead) {
        this.scene.remove(arc.line);
        arc.dead = true;
        releaseArc(arc);
      }
    }
    this.shockwaves = [];
    this.rings = [];
    this.arcs = [];
    this.core = null;
  }
}
