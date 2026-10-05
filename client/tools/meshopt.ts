// Repack GLBs with EXT_meshopt_compression — decodes through three's
// MeshoptDecoder once wired on the loader. `bun meshopt.ts <dir|file...>`
// rewrites each .glb in place (backup skipped — git is the restore path).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, resample, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
});

const targets: string[] = [];
for (const a of process.argv.slice(2)) {
  const s = statSync(a);
  if (s.isDirectory()) targets.push(...readdirSync(a).filter(f => f.endsWith('.glb')).map(f => join(a, f)));
  else targets.push(a);
}
for (const t of targets) {
  const before = statSync(t).size;
  const doc = await io.read(t);
  await doc.transform(resample(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  writeFileSync(t, await io.writeBinary(doc));
  const after = statSync(t).size;
  console.log(`${t}: ${(before / 1e6).toFixed(2)}MB -> ${(after / 1e6).toFixed(2)}MB`);
}
