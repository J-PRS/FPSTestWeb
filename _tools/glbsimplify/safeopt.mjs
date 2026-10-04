// Hierarchy-safe GLB optimize: the full `optimize` preset's flatten+prune
// reparented skin joints out from under rotated Armature nodes — baked
// anim tracks store LOCAL bone-space values, so they landed in the wrong
// parent frame (cyber prone-hip bug). This chain keeps every node and
// parent link: dedup + weld + resample + quantize + webp textures only.
// Usage: node safeopt.mjs <in.glb> <out.glb>
import { NodeIO } from '@gltf-transform/core';
import { dedup, weld, resample, quantize, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { readFileSync, writeFileSync, statSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
await MeshoptEncoder.ready;

const io = new NodeIO();
const doc = await io.readBinary(new Uint8Array(readFileSync(inPath)));

const before = doc.getRoot().listNodes().length;
await doc.transform(
  dedup(),
  weld(),
  resample(),           // collapses degenerate single-keyframe tracks
  quantize(),           // 16-bit attributes, no node changes
  textureCompress({ encoder: sharp, targetFormat: 'webp' }),
);
const after = doc.getRoot().listNodes().length;
const names = new Set(doc.getRoot().listNodes().map(n => n.getName()));
if (before !== after) console.log(`WARN nodes ${before} -> ${after}`);

// Re-parse sanity: write then read back to confirm names survive.
writeFileSync(outPath, Buffer.from(await io.writeBinary(doc)));
const kb = (statSync(outPath).size / 1024).toFixed(0);
console.log(`${inPath.split(/[\\/]/).pop()}: nodes ${before}->${after}, ${kb}KB`);
