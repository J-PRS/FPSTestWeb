import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import { acquireBatch, retireBatch, type BatchMap } from '../core/batchPool.js';
import { markProbe } from '../core/fxDiag.js';
import type { Terrain } from '../world/terrain.js';

const SEGS = 64;
const LIFT = 0.18; // clearance above terrain so chords between samples don't clip
const VERTS = (SEGS + 1) * 2;
const MAX_RINGS = 48;

// Expanding ground ring draped onto the terrain — vertices are re-sampled to
// getHeight() every frame at the live radius, so it hugs slopes (RTS
// selection-ring style). Pure decal semantics: the depth test decides
// visibility, so arcs behind a ridge simply occlude. (An earlier
// GreaterDepth "ghost" re-pass showed buried arcs dimly — it also painted
// rings through entire mountains and was removed.)
//
// All live rings write into ONE shared vertex buffer (position + color) —
// per-ring color and fade are baked into vertex rgb: additive blending
// makes black invisible, so scaling the rgb IS the opacity.

interface RingPool {
  pos: THREE.BufferAttribute;
  col: THREE.BufferAttribute;
  free: number[];
  live: number;
  scene: THREE.Scene;
  geo: THREE.BufferGeometry;
  meshes: THREE.Mesh[];
  mats: THREE.Material[];
}

// Dynamic batching, same contract as the trail/dot batches: spawn a
// sibling pool when every slot is taken (two extra draw calls: main +
// ghost), retire an overflow pool the moment it empties — pools[0] is
// the floor. The old code silently no-op'd the ring once 48 were live.
const pools: BatchMap<THREE.Scene, RingPool> = new Map();

function makePool(scene: THREE.Scene): RingPool {
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(MAX_RINGS * VERTS * 3), 3);
  const col = new THREE.BufferAttribute(new Float32Array(MAX_RINGS * VERTS * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  col.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  geo.setAttribute('color', col);
  const idx = new Uint32Array(MAX_RINGS * SEGS * 6);
  for (let s = 0; s < MAX_RINGS; s += 1) {
    const vo = s * VERTS, io = s * SEGS * 6;
    for (let i = 0; i < SEGS; i += 1) {
      const o = io + i * 6, v = vo + i * 2;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v + 1; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
    }
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 1,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    depthWrite: false,
    // fog:false is load-bearing: the fade only scales vertex RGB to
    // black (alpha stays 1), so the fog mix would repainted dead rings
    // as fog-colored silhouettes until a new shot reused the slot.
    fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);
  markProbe(mesh, { kind: 'fxMesh', label: 'terrainRing' });

  const pool: RingPool = {
    pos, col, free: [], live: 0,
    scene, geo, meshes: [mesh], mats: [mat],
  };
  for (let i = MAX_RINGS - 1; i >= 0; i -= 1) {pool.free.push(i);}
  return pool;
}

function acquireRingSlot(scene: THREE.Scene): { pool: RingPool; slot: number } {
  const p = acquireBatch(pools, scene, makePool,( b): boolean => b.live < MAX_RINGS);
p.live += 1;
  return { pool: p, slot: p.free.pop()! };
}

function releaseRingSlot(pool: RingPool, slot: number): void {
  pool.free.push(slot);
pool.live -= 1;
  retireBatch(pools, pool.scene, pool,( p): boolean => p.live === 0,( p): void => {
    for (const m of p.meshes) {p.scene.remove(m);}
    p.geo.dispose();
    for (const m of p.mats) {m.dispose();}
  });
}

export class TerrainRing {
  private slot: number;
  private pool: RingPool;
  private elapsed = 0;
  private rgb: [number, number, number];

  private terrain?: Terrain;
  private baseOpacity: number;
  private staticRing = false;

  constructor(
    scene: THREE.Scene,
    private center: THREE.Vector3,
    color: number,
    private life: number,
    private maxRadius: number,
    ...opts: [terrain?: Terrain, baseOpacity?: number, staticRing?: boolean]) {
    const [terrain, baseOpacity = 0.8, staticRing = false] = opts;
    this.terrain = terrain;
    this.baseOpacity = baseOpacity;
    this.staticRing = staticRing;
    const a = acquireRingSlot(scene);
    this.pool = a.pool;
    this.slot = a.slot;
    const hot = new THREE.Color(color).multiplyScalar(EMIT_GAIN);
    this.rgb = [hot.r, hot.g, hot.b];
  }

  update(dt: number): boolean {
    this.elapsed += dt;
    if (this.elapsed >= this.life || this.slot < 0) {
      this.dispose();
      return false;
    }
    const t = this.elapsed / this.life;
    if (this.staticRing) {
      // Spawns AT the AOE edge and fades: alpha drops AND the band thins
      // (inner radius closes on the outer) so the ring evaporates at the
      // true damage line instead of expanding past it.
      const r = this.maxRadius;
      const inner = r * (0.85 + 0.15 * t);
      this.drapeBand(r, inner, (1 - t) * this.baseOpacity);
      return true;
    }
    this.drape(this.maxRadius * t, (1 - t) * this.baseOpacity);
    return true;
  }

  private drape(radius: number, opacity: number): void {
    this.drapeBand(radius, radius * 0.85, opacity);
  }

  private drapeBand(radius: number, inner: number, opacity: number): void {
    const pos = this.pool.pos.array as Float32Array;
    const col = this.pool.col.array as Float32Array;
    const [r, g, b] = this.rgb;
    const { x: cx, y: cy, z: cz } = this.center;
    const base = this.slot * VERTS;
    for (let i = 0; i <= SEGS; i += 1) {
      const ang = (i / SEGS) * Math.PI * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      for (const rr of [inner, radius] as const) {
        const wx = cx + c * rr;
        const wz = cz + s * rr;
        const wy = this.terrain ? this.terrain.getHeight(wx, wz) + LIFT : cy;
        const vi = (base + i * 2 + (rr === inner ? 0 : 1)) * 3;
        pos[vi] = wx; pos[vi + 1] = wy; pos[vi + 2] = wz;
        col[vi] = r * opacity; col[vi + 1] = g * opacity; col[vi + 2] = b * opacity;
      }
    }
    // Update ranges, not whole-buffer uploads — each ring writes only
    // its own slot span (~1.5KB) instead of the full ~75KB per attribute.
    const vo = base * 3;
    this.pool.pos.addUpdateRange(vo, VERTS * 3);
    this.pool.pos.needsUpdate = true;
    this.pool.col.addUpdateRange(vo, VERTS * 3);
    this.pool.col.needsUpdate = true;
  }

  dispose(): void {
    if (this.slot < 0) {return;}
    const col = this.pool.col.array as Float32Array;
    const base = this.slot * VERTS * 3;
    col.fill(0, base, base + VERTS * 3);
    this.pool.col.addUpdateRange(base, VERTS * 3);
    this.pool.col.needsUpdate = true;
    releaseRingSlot(this.pool, this.slot);
    this.slot = -1;
  }
}
