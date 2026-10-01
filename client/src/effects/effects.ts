import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';
import { impactBurst, blastBurst } from './vfx.js';
import * as du from './effectDust.js';
import type { Terrain } from '../world/terrain.js';

interface Particle {
  bucket: InstBucket;
  slot: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: number;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  color: THREE.Color;
  opacity: number;
  noGravity?: boolean;
  sizeScale: number; // multiplies the update-loop scale formula (explosion flash)
}

// scratch — never retained
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _c = new THREE.Color();
const _m = new THREE.Matrix4();

const POOL_MAX = 128;

/** One InstancedMesh per (geometry, blending, depthWrite, side) combo —
 *  pooled particles share one draw call and one material instead of a
 *  unique material each (~80 programs re-keyed every frame before).
 *  Per-instance fade needs an alpha attribute MeshBasicMaterial lacks,
 *  so the shader gets a tiny patch multiplying diffuseColor.a. */
class InstBucket {
  readonly mesh: THREE.InstancedMesh;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private free: number[] = [];
  used = 0;

  constructor(geo: THREE.BufferGeometry, mat: THREE.MeshBasicMaterial) {
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL_MAX), 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo = geo.clone();
    geo.setAttribute('aAlpha', this.alphaAttr);
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, POOL_MAX);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(POOL_MAX * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // instances span the map; culling is per-slot pointless
    for (let i = POOL_MAX - 1; i >= 0; i--) this.free.push(i);
  }

  take(): number {
    const s = this.free.pop();
    if (s === undefined) return -1;
    this.used++;
    return s;
  }

  give(s: number): void {
    // Slot may sit inside the rendered [0,count) span — bury it so a
    // stale matrix doesn't flash a ghost quad for one frame.
    _m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(s, _m);
    this.alphaAttr.array[s] = 0;
    this.free.push(s);
    this.used--;
  }

  write(p: Particle): void {
    _m.compose(p.pos, p.quat, _v3.setScalar(p.scale));
    this.mesh.setMatrixAt(p.slot, _m);
    this.mesh.setColorAt(p.slot, p.color);
    this.alphaAttr.array[p.slot] = p.opacity;
  }

  flush(highSlot: number): void {
    this.mesh.count = highSlot + 1;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }
}

interface SpawnOpts {
  opacity?: number;
  additive?: boolean;
  depthWrite?: boolean;
  side?: THREE.Side;
  noGravity?: boolean;
  sizeScale?: number;
}

// Scratch object for lookAt orientation — discs need a facing quaternion
// without a real Mesh (instanced slots have none).
const _dummy = new THREE.Object3D();

/**
 * Particle effects — spawns are instanced into per-material buckets
 * (InstBucket): every pooled particle of a config shares one draw call
 * and one material.
 */
interface BeamFx {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
}

export class EffectsManager {
  private scene: THREE.Scene;
  private particles: Particle[] = [];
  private deadP: Particle[] = [];
  private buckets = new Map<string, InstBucket>();
  sharedGeo: THREE.SphereGeometry;
  private sharedDiscGeo: THREE.CircleGeometry;
  private beamGeo: THREE.CylinderGeometry;
  private beams: BeamFx[] = [];
  private beamPool: BeamFx[] = [];
  terrain: Terrain | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.sharedGeo = new THREE.SphereGeometry(0.15, 8, 8);
    this.sharedDiscGeo = new THREE.CircleGeometry(0.5, 8);
    this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  }

  setTerrain(terrain: Terrain): void {
    this.terrain = terrain;
  }

  private bucketFor(geo: THREE.BufferGeometry, opts: SpawnOpts): InstBucket {
    const additive = opts.additive ?? false;
    const depthWrite = opts.depthWrite ?? true;
    const side = opts.side ?? THREE.FrontSide;
    const key = `${geo.uuid}|${additive ? 1 : 0}|${depthWrite ? 1 : 0}|${side}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = new InstBucket(geo, new THREE.MeshBasicMaterial({
        transparent: true,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite,
        side,
      }));
      this.scene.add(b.mesh);
      this.buckets.set(key, b);
    }
    return b;
  }

  alloc(geo: THREE.BufferGeometry, pos: THREE.Vector3, vel: THREE.Vector3, life: number, color: THREE.Color, opts: SpawnOpts = {}): Particle | null {
    const bucket = this.bucketFor(geo, opts);
    const slot = bucket.take();
    if (slot < 0) return null;
    let p = this.deadP.pop();
    if (!p) {
      p = { bucket, slot: -1, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1,
        vel: new THREE.Vector3(), life: 0, maxLife: 0,
        color: new THREE.Color(), opacity: 1, sizeScale: 1 };
    }
    p.bucket = bucket;
    p.slot = slot;
    p.pos.copy(pos);
    p.quat.identity();
    p.scale = 1;
    p.vel.copy(vel);
    p.life = p.maxLife = life;
    p.color.copy(color);
    p.opacity = opts.opacity ?? 0.7;
    p.noGravity = opts.noGravity;
    p.sizeScale = opts.sizeScale ?? 1;
    this.particles.push(p);
    return p;
  }

  spawnExplosion(pos: THREE.Vector3, radius: number, count: number): void {
    // Batched burst — hemisphere elv 0..π/2 (old normalized (±, +, ±) dirs),
    // HSL(0.05–0.13, 1, 0.5–0.8) ≈ the orange pair below.
    blastBurst(pos, {
      count,
      elvBase: 0, elvSpan: Math.PI / 2,
      spdMin: radius * 2, spdMax: radius * 5, vy: 0,
      lifeMin: 0.4, lifeMax: 0.9,
      sizeMin: 0.25, sizeMax: 0.5,
      gravity: GRAVITY,
      c1: [1.0, 0.5, 0.0], c2: [1.0, 0.85, 0.4],
      opacity: 0.6,
    }, true);

    // Flash sphere — sharedGeo scaled up via sizeScale in the update loop
    _c.setHex(0xffcc44);
    _v.set(0, 0, 0);
    this.alloc(this.sharedGeo, pos, _v, 0.12, _c, { opacity: 0.9, sizeScale: (radius * 0.8) / 0.15 });
  }

  // Small spark burst for bullet impacts — quarks batch now (one shared
  // draw call); the flash quad stays local, it's a single pooled mesh.
  spawnImpact(pos: THREE.Vector3, vel: THREE.Vector3): void {
    const back = vel.lengthSq() > 0 ? _v.copy(vel).normalize().negate() : _v.set(0, 1, 0);
    impactBurst(pos, vel);
    // Tiny flash at the exact hit point — quad faces along the shot direction
    _c.setHex(0xffee99);
    _v2.copy(pos).addScaledVector(back, 0.05);
    const flash = this.alloc(this.sharedDiscGeo, _v2, _v3.set(0, 0, 0), 0.06, _c, { opacity: 0.8, additive: true, depthWrite: false, side: THREE.DoubleSide });
    if (flash) {
      flash.scale = 0.5;
      _dummy.position.copy(flash.pos);
      _dummy.lookAt(_v3.copy(pos).add(back));
      flash.quat.copy(_dummy.quaternion);
    }
  }

  // Bullet pock — small dark disc pressed onto the terrain surface, shrinks
  // out over ~1s. Pooled; only stamped for actual terrain hits (a mid-air
  // mark where a ball stood would read as a floating smudge).
  spawnBulletMark(pos: THREE.Vector3): void {
    if (!this.terrain) return;
    const e = 0.4;
    const h  = this.terrain.getHeight(pos.x, pos.z);
    const hx = this.terrain.getHeight(pos.x + e, pos.z) - this.terrain.getHeight(pos.x - e, pos.z);
    const hz = this.terrain.getHeight(pos.x, pos.z + e) - this.terrain.getHeight(pos.x, pos.z - e);
    _v.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize(); // surface normal
    // Lift along the normal enough to clear surface bumps between the
    // disc's center and rim — 3cm buried edges on anything but flat ground
    _v2.set(pos.x, h, pos.z).addScaledVector(_v, 0.12);
    _c.setHex(0x14100c);
    const mark = this.alloc(this.sharedDiscGeo, _v2, _v3.set(0, 0, 0), 1.0, _c,
      { opacity: 0.7, depthWrite: false, noGravity: true, sizeScale: 0.2, side: THREE.DoubleSide });
    if (mark) {
      _dummy.position.copy(mark.pos);
      _dummy.lookAt(_v3.copy(_v2).add(_v));
      mark.quat.copy(_dummy.quaternion);
    }
  }

  // Jet contrail — NOT an exhaust cloud. Tribes-style: a thin additive
  // streak fired DOWN hard (~16m/s) so particles exit the view cone in
  // ~0.1s — looking down you see a stream leaving, not a column of fat
  // blobs you're inside of. Additive + small sizeScale so overlaps add
  // light instead of mass, and the grow-on-age update reads as streaks.
  spawnJetpack(pos: THREE.Vector3): void { du.spawnJetpack(this, pos); }
  spawnWarpTrail(pos: THREE.Vector3): void { du.spawnWarpTrail(pos); }
  spawnJumpDust(pos: THREE.Vector3): void { du.spawnJumpDust(this, pos); }
  spawnBounce(pos: THREE.Vector3, dir: THREE.Vector3): void { du.spawnBounce(this, pos, dir); }
  spawnSkiDust(pos: THREE.Vector3, velocity: THREE.Vector3): void { du.spawnSkiDust(this, pos, velocity); }
  spawnMoveDust(pos: THREE.Vector3, vel: THREE.Vector3, speed: number, radius: number): void { du.spawnMoveDust(this, pos, vel, speed, radius); }
  spawnFlyTrail(pos: THREE.Vector3, vel: THREE.Vector3, speed: number): void { du.spawnFlyTrail(this, pos, vel, speed); }

  // Hitscan beam flash (remote railgun discharge): a transient additive
  // rod from→to that fades fast. Pooled like particles — mesh+mat reused.
  spawnBeam(from: THREE.Vector3, to: THREE.Vector3, colorHex = 0x99eeff): void {
    _v.subVectors(to, from);
    const len = _v.length();
    if (len < 0.01) return;
    let b = this.beamPool.pop();
    if (!b) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      b = { mesh: new THREE.Mesh(this.beamGeo, mat), mat, life: 0, maxLife: 0 };
    }
    b.mesh.position.copy(from).addScaledVector(_v, 0.5);
    b.mesh.quaternion.setFromUnitVectors(_v3.set(0, 1, 0), _v.normalize());
    b.mesh.scale.set(0.14, len, 0.14);
    b.mat.color.setHex(colorHex);
    b.mat.opacity = 0.85;
    b.life = b.maxLife = 0.35;
    this.scene.add(b.mesh);
    this.beams.push(b);
  }

  update(dt: number): void {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt;
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        this.beamPool.push(b);
        this.beams[i] = this.beams[this.beams.length - 1];
        this.beams.pop();
        continue;
      }
      const t = b.life / b.maxLife;
      b.mat.opacity = t * 0.85;
      b.mesh.scale.x = b.mesh.scale.z = 0.14 * (0.4 + t); // the collapse sells the discharge
    }
    const gravity = GRAVITY;
    const highOf = new Map<InstBucket, number>();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.bucket.give(p.slot);
        this.deadP.push(p);
        const last = this.particles.length - 1;
        this.particles[i] = this.particles[last];
        this.particles.pop(); // order doesn't matter — splice is O(n) shift
        continue;
      }
      const t = p.life / p.maxLife;
      p.opacity = t * 0.6;
      if (!p.noGravity) {
        p.vel.y += gravity * dt;
      }
      p.pos.addScaledVector(p.vel, dt);
      p.scale = (0.3 + t * 1.4) * p.sizeScale;
      p.bucket.write(p);
      if (p.slot > (highOf.get(p.bucket) ?? -1)) highOf.set(p.bucket, p.slot);
    }
    for (const [bucket, high] of highOf) bucket.flush(high);
    for (const bucket of this.buckets.values()) {
      if (!highOf.has(bucket)) bucket.mesh.count = 0;
    }
  }
}
