// Decimate a GLB's triangle count by rewriting ONLY the index buffer.
// Attribute streams (JOINTS/WEIGHTS/UV/NORMAL) are untouched — meshopt
// simplify() emits new indices into the original vertex order, so skin
// bindings stay valid. Verts remain in memory; per-frame skinning/GPU
// vertex cost drops with the triangle count.
// Usage: node decimate.mjs <in.glb> <out.glb> <ratio 0..1>
import { NodeIO } from '@gltf-transform/core';
import { weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readFileSync, writeFileSync } from 'fs';

const [inPath, outPath, ratioStr] = process.argv.slice(2);
const ratio = parseFloat(ratioStr || '0.3');
await MeshoptSimplifier.ready;

const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(readFileSync(inPath)));
// Unwelded verts can't collapse; weld remaps all attributes itself.
await doc.transform(weld());

for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const indices = prim.getIndices();
    const pos = prim.getAttribute('POSITION');
    if (!indices || !pos) continue;
    const idx = indices.getArray();
    const verts = new Float32Array(pos.getArray());
    const target = Math.max(96, Math.floor((idx.length / 3) * ratio) * 3);
    const [newIdx, err] = MeshoptSimplifier.simplifySloppy(idx, verts, 3, null, target, 0.1);
    const typed = idx.constructor.name === 'Uint16Array' && newIdx.reduce((m, v) => Math.max(m, v), 0) > 65535
      ? new Uint32Array(newIdx) : newIdx.constructor === Uint32Array ? new Uint32Array(newIdx) : new Uint16Array(newIdx);
    indices.setArray(typed);
    console.log(`${mesh.getName()}: ${idx.length / 3} -> ${newIdx.length / 3} tris (err ${err.toFixed(3)})`);
  }
}
writeFileSync(outPath, Buffer.from(await io.writeBinary(doc)));
