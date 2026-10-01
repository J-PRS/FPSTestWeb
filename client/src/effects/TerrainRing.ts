import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import { Terrain } from '../world/terrain.js';

const SEGS = 64;
const LIFT = 0.18; // clearance above terrain so chords between samples don't clip
const VERTS = (SEGS + 1) * 2;
const MAX_RINGS = 48;

// Expanding ground ring draped onto the terrain — vertices are re-sampled to
// getHeight() every frame at the live radius, so it hugs slopes (RTS
// selection-ring style). A second "ghost" pass draws only the fragments the
// terrain occludes (GreaterDepth) at reduced opacity, so buried arcs show
// through as a dimmer version instead of vanishing.
//
// All live rings write into ONE shared vertex buffer (position + color) —
// a ring used to cost 2 draw calls each (main + ghost), which made a busy
// firefight spend ~40 draws on floor decals alone. Per-ring color and fade
// are baked into vertex rgb: additive blending makes black invisible, so
// scaling the rgb IS the opacity.

interface RingPool {
  pos: THREE.BufferAttribute;
  col: THREE.BufferAttribute;
  ghostCol: THREE.BufferAttribute;
  free: number[];
  live: number;
}

const pools = new Map<THREE.Scene, RingPool>();

function ringPool(scene: THREE.Scene): RingPool {
  const hit = pools.get(scene);
  if (hit) return hit;

  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(MAX_RINGS * VERTS * 3), 3);
  const col = new THREE.BufferAttribute(new Float32Array(MAX_RINGS * VERTS * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  col.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  geo.setAttribute('color', col);
  const idx = new Uint32Array(MAX_RINGS * SEGS * 6);
  for (let s = 0; s < MAX_RINGS; s++) {
    const vo = s * VERTS, io = s * SEGS * 6;
    for (let i = 0; i < SEGS; i++) {
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
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);

  // Ghost re-pass needs its own color buffer — same positions, dimmer rgb.
  const ghostGeo = new THREE.BufferGeometry();
  const ghostCol = new THREE.BufferAttribute(new Float32Array(MAX_RINGS * VERTS * 3), 3);
  ghostCol.setUsage(THREE.DynamicDrawUsage);
  ghostGeo.setAttribute('position', pos); // shared with the main mesh
  ghostGeo.setAttribute('color', ghostCol);
  ghostGeo.setIndex(geo.index);
  const ghostMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 1,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    depthWrite: false, depthFunc: THREE.GreaterDepth,
  });
  const ghostMesh = new THREE.Mesh(ghostGeo, ghostMat);
  ghostMesh.frustumCulled = false;
  ghostMesh.layers.enable(BLOOM_LAYER);
  scene.add(ghostMesh);

  const pool: RingPool = { pos, col, ghostCol, free: [], live: 0 };
  for (let i = MAX_RINGS - 1; i >= 0; i--) pool.free.push(i);
  pools.set(scene, pool);
  return pool;
}

export class TerrainRing {
  private slot: number;
  private pool: RingPool;
  private elapsed = 0;
  private rgb: [number, number, number];

  private terrain?: Terrain;
  private baseOpacity: number;
  private ghostOpacity: number;

  constructor(
    scene: THREE.Scene,
    private center: THREE.Vector3,
    color: number,
    private life: number,
    private maxRadius: number,
    ...opts: [terrain?: Terrain, baseOpacity?: number, ghostOpacity?: number]) {
    // Ghost is a GreaterDepth re-pass: it intentionally paints the arcs
    // terrain occludes. Kept faint — at 0.35 a ring on the far side of a
    // hill read as a full neon circle drawn ON the hillside.
    const [terrain, baseOpacity = 0.8, ghostOpacity = 0.12] = opts;
    this.terrain = terrain;
    this.baseOpacity = baseOpacity;
    this.ghostOpacity = ghostOpacity;
    this.pool = ringPool(scene);
    const hot = new THREE.Color(color).multiplyScalar(EMIT_GAIN);
    this.rgb = [hot.r, hot.g, hot.b];
    if (this.pool.live >= MAX_RINGS) {
      // Saturated — fail soft: mark the slot dead so update() disposes instantly
      this.slot = -1;
      this.elapsed = life;
      return;
    }
    this.slot = this.pool.free.pop()!;
    this.pool.live++;
  }

  update(dt: number): boolean {
    this.elapsed += dt;
    if (this.elapsed >= this.life || this.slot < 0) {
      this.dispose();
      return false;
    }
    const t = this.elapsed / this.life;
    this.drape(this.maxRadius * t, (1 - t) * this.baseOpacity, (1 - t) * this.ghostOpacity);
    return true;
  }

  private drape(radius: number, opacity: number, ghostOpacity: number): void {
    const pos = this.pool.pos.array as Float32Array;
    const col = this.pool.col.array as Float32Array;
    const gcol = this.pool.ghostCol.array as Float32Array;
    const [r, g, b] = this.rgb;
    const inner = radius * 0.85;
    const { x: cx, y: cy, z: cz } = this.center;
    const base = this.slot * VERTS;
    for (let i = 0; i <= SEGS; i++) {
      const ang = (i / SEGS) * Math.PI * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      for (const rr of [inner, radius] as const) {
        const wx = cx + c * rr;
        const wz = cz + s * rr;
        const wy = this.terrain ? this.terrain.getHeight(wx, wz) + LIFT : cy;
        const vi = (base + i * 2 + (rr === inner ? 0 : 1)) * 3;
        pos[vi] = wx; pos[vi + 1] = wy; pos[vi + 2] = wz;
        col[vi] = r * opacity; col[vi + 1] = g * opacity; col[vi + 2] = b * opacity;
        gcol[vi] = r * ghostOpacity; gcol[vi + 1] = g * ghostOpacity; gcol[vi + 2] = b * ghostOpacity;
      }
    }
    // Update ranges, not whole-buffer uploads — each ring writes only
    // its own slot span (~1.5KB) instead of the full ~75KB per attribute.
    const vo = base * 3;
    this.pool.pos.addUpdateRange(vo, VERTS * 3);
    this.pool.pos.needsUpdate = true;
    this.pool.col.addUpdateRange(vo, VERTS * 3);
    this.pool.col.needsUpdate = true;
    this.pool.ghostCol.addUpdateRange(vo, VERTS * 3);
    this.pool.ghostCol.needsUpdate = true;
  }

  dispose(): void {
    if (this.slot < 0) return;
    const col = this.pool.col.array as Float32Array;
    const gcol = this.pool.ghostCol.array as Float32Array;
    const base = this.slot * VERTS * 3;
    col.fill(0, base, base + VERTS * 3);
    gcol.fill(0, base, base + VERTS * 3);
    this.pool.col.addUpdateRange(base, VERTS * 3);
    this.pool.col.needsUpdate = true;
    this.pool.ghostCol.addUpdateRange(base, VERTS * 3);
    this.pool.ghostCol.needsUpdate = true;
    this.pool.free.push(this.slot);
    this.pool.live--;
    this.slot = -1;
  }
}
