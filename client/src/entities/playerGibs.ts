/**
 * playerGibs — real body parts for the death shatter. Skinned verts only
 * exist in bind pose, so at load we group every triangle under its
 * dominant bone (arms/legs/head separate) and keep the ORIGINAL vertex
 * indices. On death each part is baked through SkinnedMesh.applyBoneTransform
 * — full weight blending at the seams, bindMatrix handled, mesh-node
 * transforms handled. One index-grouping pass at load; ~30k skinned
 * vertex bakes per kill (a few ms, once).
 */
import * as THREE from 'three';

export interface GibPart { mesh: THREE.SkinnedMesh; indices: number[] }

export function buildGibParts(model: THREE.Group): GibPart[] | null {
  const out: GibPart[] = [];
  model.traverse((o) => {
    const sk = o as THREE.SkinnedMesh;
    if (!sk.isSkinnedMesh) {return;}
    const geo = sk.geometry;
    const sIdx = geo.getAttribute('skinIndex');
    const sWt = geo.getAttribute('skinWeight');
    const pos = geo.getAttribute('position');
    if (!pos || !sIdx || !sWt) {return;}
    const {index} = geo;
    const triCount = Math.floor((index ? index.count : pos.count) / 3);
    const domBone = (v: number): number => {
      let bi = 0, bw = -1;
      for (let k = 0; k < 4; k += 1) {
        const w = sWt.getComponent(v, k);
        if (w > bw) { bw = w; bi = sIdx.getComponent(v, k); }
      }
      return bi;
    };
    const buckets = new Map<number, number[]>();
    for (let t = 0; t < triCount; t += 1) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      const bone = domBone(a);
      const arr = buckets.get(bone) ?? buckets.set(bone, []).get(bone)!;
      arr.push(a, b, c);
    }
    for (const [bi, indices] of buckets) {
      if (!sk.skeleton.bones[bi] || indices.length < 9) {continue;} // a triangle or two isn't a part
      out.push({ mesh: sk, indices });
    }
  });
  return out.length > 0 ? out : null;
}

/** Posed body-part fragments at the corpse's current stance — recentered
 *  chunk geometries + their world centroids. */
export function bakeDeathParts(model: THREE.Group, parts: GibPart[]): { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] {
  model.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const out: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] = [];
  for (const p of parts) {
    const pos = p.mesh.geometry.getAttribute('position');
    const verts = new Float32Array(p.indices.length * 3);
    for (let i = 0; i < p.indices.length; i += 1) {
      const vi = p.indices[i];
      // Full skinned transform: bindMatrix → Σw·(boneWorld×boneInverse)
      // → bindMatrixInverse, then out to world via the mesh matrix.
      v.fromBufferAttribute(pos, vi);
      p.mesh.applyBoneTransform(vi, v);
      v.applyMatrix4(p.mesh.matrixWorld);
      verts[i * 3] = v.x; verts[i * 3 + 1] = v.y; verts[i * 3 + 2] = v.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const c = g.boundingSphere!.center.clone();
    g.translate(-c.x, -c.y, -c.z);
    out.push({ geo: g, pos: c });
  }
  return out;
}
