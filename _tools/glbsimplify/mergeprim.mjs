import { NodeIO } from '@gltf-transform/core';
import { joinPrimitives } from '@gltf-transform/functions';
import { readFileSync, writeFileSync } from 'fs';

const [inPath, outPath] = process.argv.slice(2);
const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(readFileSync(inPath)));
for (const mesh of doc.getRoot().listMeshes()) {
  const n = mesh.listPrimitives().length;
  console.log(`${mesh.getName()}: ${n} prims`);
  if (n > 1) {
    try { joinPrimitives(mesh); console.log(`  -> ${mesh.listPrimitives().length}`); }
    catch (e) { console.log(`  join failed: ${e.message}`); }
  }
}
writeFileSync(outPath, Buffer.from(await io.writeBinary(doc)));
