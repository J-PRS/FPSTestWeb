// strip_anims.ts — dedupe the byte-identical 32-clip set embedded in
// every class_*.glb (~518KB each): emit ONE class_anims.glb (skeleton +
// clips only) and strip animations from all class files.
//   bun _tools/strip_anims.ts
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'public/assets/models';
const OUT_PACK = join(DIR, 'class_anims.glb');
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

// Pack: scout's doc minus meshes/skins/materials/textures — nodes stay
// (channels target them), everything else prunes out.
const pack = await io.read(join(DIR, 'class_scout.glb'));
for (const n of pack.getRoot().listNodes()) {n.setMesh(null);}
for (const s of pack.getRoot().listSkins()) {s.dispose();}
await pack.transform(prune());
await io.write(OUT_PACK, pack);
console.log(`class_anims.glb: ${pack.getRoot().listAnimations().length} clips`);

// Strip: dispose every animation, prune orphaned samplers/accessors.
mkdirSync(join(DIR, '_with_anims'), { recursive: true });
for (const f of readdirSync(DIR).filter((n) => n.startsWith('class_') && n.endsWith('.glb'))) {
  const p = join(DIR, f);
  copyFileSync(p, join(DIR, '_with_anims', f)); // originals kept for rollback
  const d = await io.read(p);
  for (const a of d.getRoot().listAnimations()) {a.dispose();}
  await d.transform(prune());
  await io.write(p, d);
  console.log(`${f} stripped`);
}
