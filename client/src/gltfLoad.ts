import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// public/ GLBs ship meshopt-compressed (see client/tools_meshopt.ts) — every
// loader needs the decoder or load() rejects with EXT_meshopt_compression.
export function mkGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}
