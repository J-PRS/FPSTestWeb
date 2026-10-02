// Merge each skinned GLB's primitives into ONE mesh — the census showed
// every rig draws 5 meshes (Mannequin_1/2 + 3 DEF-* parts) = ~90 draw
// calls for 18 remotes. Joined skinned prims share JOINTS/WEIGHTS
// streams, so skinning is untouched; the rig renders in one call.
import { NodeIO } from '@gltf-transform/core';
import { join } from '@gltf-transform/functions';
import { readFileSync, writeFileSync } from 'fs';

const [inPath, outPath] = process.argv.slice(2);
const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(readFileSync(inPath)));
const before = doc.getRoot().listMeshes().length;
await doc.transform(join());
const after = doc.getRoot().listMeshes().length;
console.log(`meshes ${before} -> ${after}`);
writeFileSync(outPath, Buffer.from(await io.writeBinary(doc)));
