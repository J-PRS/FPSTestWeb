import { NodeIO } from '@gltf-transform/core';
import { readFileSync } from 'fs';
const [inPath] = process.argv.slice(2);
const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(readFileSync(inPath)));
for (const mesh of doc.getRoot().listMeshes()) {
  for (const p of mesh.listPrimitives()) {
    const attrs = p.listSemantics().join(',');
    console.log(`${mesh.getName()} prim: mat=${p.getMaterial()?.getName()} attrs=[${attrs}] tris=${(p.getIndices()?.getCount() ?? 0)/3}`);
  }
}
