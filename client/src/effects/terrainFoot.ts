import * as THREE from 'three';
import type { Terrain } from '../world/terrain.js';
import { markProbe } from '../core/fxDiag.js';

const _v = new THREE.Vector3();

/**
 * TerrainFoot — the "extend the rim into the ground" seat helper.
 *
 * A 2-ring open wall: top ring is a rim circle (optionally transformed by a
 * quaternion so it tracks a slope-tilted body), bottom ring is the SAME XZ
 * column pushed `depth` below the terrain at that spot. The wall between
 * rim and dirt is solid geometry — there is no plane that can gap, on any
 * slope/crest/hollow. Piling-foundation approach: don't estimate contact,
 * extrude until provably inside the ground.
 */
export class TerrainFoot {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private posAttr: THREE.BufferAttribute;
  private readonly segs: number;

  constructor(
    private scene: THREE.Scene,
    private rimRadius: number,
    private depth = 0.15,
    segs = 28,
    color = 0x4A_42_35, // dirt
  ) {
    this.segs = segs;
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array((segs + 1) * 2 * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    const idx: number[] = [];
    const ringVerts = segs + 1;
    for (let i = 0; i < segs; i++) {
      const a = i, b = i + ringVerts;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo,
      new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    markProbe(this.mesh, { kind: 'fxMesh', label: 'terrainFoot' });
    scene.add(this.mesh);
  }

  /**
   * Weld the top ring onto the body's rim and drive the bottom ring into
   * the dirt. `baseY` is the world Y of the rim's parent origin; `quat` is
   * the body's orientation (pass undefined for an upright object).
   */
  conform(cx: number, cz: number, baseY: number, terrain: Terrain, quat?: THREE.Quaternion): void {
    this.mesh.position.set(cx, 0, cz);
    const arr = this.posAttr.array as Float32Array;
    const ringVerts = this.segs + 1;
    for (let i = 0; i <= this.segs; i++) {
      const a = (i / this.segs) * Math.PI * 2;
      _v.set(Math.cos(a) * this.rimRadius, 0.02, Math.sin(a) * this.rimRadius);
      if (quat) {_v.applyQuaternion(quat);}
      const wx = cx + _v.x, wz = cz + _v.z;
      const o = i * 3, ob = (i + ringVerts) * 3;
      arr[o] = _v.x;
      arr[o + 1] = baseY + _v.y;
      arr[o + 2] = _v.z;
      arr[ob] = _v.x;
      arr[ob + 1] = terrain.getHeight(wx, wz) - this.depth;
      arr[ob + 2] = _v.z;
    }
    this.posAttr.needsUpdate = true;
    this.geo.computeVertexNormals();
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
