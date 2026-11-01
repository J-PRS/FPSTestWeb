// compress_atlas.ts — shrink *_atlas.glb in place: dedup + quantize.
// Quantize is SKIN-SAFE (gltf-transform docs): positions snap to a
// 14-bit grid (inverse-bind comp handled), weights u8-normalized,
// KHR_mesh_quantization decodes natively in three's GLTFLoader.
// The mangle earlier was attribute STRIPPING, not quantization.
//   bun _tools/compress_atlas.ts
import { createRequire } from 'node:module';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const clientRequire = createRequire(join(import.meta.dir, '..', 'client', 'package.json'));
const { NodeIO } = clientRequire('@gltf-transform/core') as typeof import('@gltf-transform/core');
const { ALL_EXTENSIONS } = clientRequire('@gltf-transform/extensions') as typeof import('@gltf-transform/extensions');
const { dedup, prune, quantize } = clientRequire('@gltf-transform/functions') as typeof import('@gltf-transform/functions');
const { MeshoptDecoder } = clientRequire('meshoptimizer') as typeof import('meshoptimizer');

const DIR = join(import.meta.dir, '..', 'client', 'public', 'assets', 'models');
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

for (const f of readdirSync(DIR).filter((n) => n.endsWith('_atlas.glb'))) {
  const p = join(DIR, f);
  const before = statSync(p).size;
  const doc = await io.read(p);
  await doc.transform(
    dedup(),
    quantize({
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeColor: 8,
      quantizeGeneric: 8, // covers _AEDGE/_ABARY/_WEAR/_GRIME/_AUTH/etc
      quantizeWeight: 8,
      quantizeTexcoord: 8,
    }),
    prune(),
  );
  await io.write(p, doc);
  const after = statSync(p).size;
  console.log(`${f}: ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e3).toFixed(0)}KB`);
}
