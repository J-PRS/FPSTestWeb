import * as THREE from 'three';
import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';
import { Terrain } from '../world/terrain.js';

const SEGS = 64;
const LIFT = 0.18; // clearance above terrain so chords between samples don't clip

// Expanding ground ring draped onto the terrain — vertices are re-sampled to
// getHeight() every frame at the live radius, so it hugs slopes (RTS
// selection-ring style). A second "ghost" mesh draws only the fragments the
// terrain occludes (GreaterDepth) at reduced opacity, so buried arcs show
// through as a dimmer version instead of vanishing.
export class TerrainRing {
  private geo: THREE.BufferGeometry;
  private posAttr: THREE.BufferAttribute;
  private mat: THREE.MeshBasicMaterial;
  private mesh: THREE.Mesh;
  private ghostMat: THREE.MeshBasicMaterial;
  private ghostMesh: THREE.Mesh;
  private elapsed = 0;

  private terrain?: Terrain;
  private baseOpacity: number;
  private ghostOpacity: number;

  constructor(
    private scene: THREE.Scene,
    private center: THREE.Vector3,
    private color: number,
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
    const pos = new Float32Array((SEGS + 1) * 2 * 3);
    this.posAttr = new THREE.BufferAttribute(pos, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', this.posAttr);
    const idx = new Uint16Array(SEGS * 6);
    for (let i = 0; i < SEGS; i++) {
      const o = i * 6, v = i * 2;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v + 1; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const hot = new THREE.Color(color).multiplyScalar(EMIT_GAIN);
    this.mat = new THREE.MeshBasicMaterial({
      color: hot, transparent: true, opacity: baseOpacity,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.position.copy(center);
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(BLOOM_LAYER);
    scene.add(this.mesh);

    this.ghostMat = new THREE.MeshBasicMaterial({
      color: hot, transparent: true, opacity: ghostOpacity,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      depthWrite: false, depthFunc: THREE.GreaterDepth,
    });
    this.ghostMesh = new THREE.Mesh(this.geo, this.ghostMat);
    this.ghostMesh.position.copy(center);
    this.ghostMesh.frustumCulled = false;
    this.ghostMesh.layers.enable(BLOOM_LAYER);
    scene.add(this.ghostMesh);
  }

  update(dt: number): boolean {
    this.elapsed += dt;
    if (this.elapsed >= this.life) {
      this.dispose();
      return false;
    }
    const t = this.elapsed / this.life;
    this.drape(this.maxRadius * t);
    this.mat.opacity = (1 - t) * this.baseOpacity;
    this.ghostMat.opacity = (1 - t) * this.ghostOpacity;
    return true;
  }

  private drape(radius: number): void {
    const arr = this.posAttr.array as Float32Array;
    const inner = radius * 0.85;
    const { x: cx, y: cy, z: cz } = this.center;
    for (let i = 0; i <= SEGS; i++) {
      const ang = (i / SEGS) * Math.PI * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      const o = i * 6;
      for (const r of [inner, radius] as const) {
        const wx = cx + c * r;
        const wz = cz + s * r;
        const wy = this.terrain ? this.terrain.getHeight(wx, wz) + LIFT : cy;
        const vo = o + (r === inner ? 0 : 3);
        arr[vo] = wx - cx; arr[vo + 1] = wy - cy; arr[vo + 2] = wz - cz;
      }
    }
    this.posAttr.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.scene.remove(this.ghostMesh);
    this.geo.dispose(); // shared by both meshes — dispose once
    this.mat.dispose();
    this.ghostMat.dispose();
  }
}
