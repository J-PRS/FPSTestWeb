import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// public/ GLBs ship meshopt-compressed (see client/tools_meshopt.ts) — every
// loader needs the decoder or load() rejects with EXT_meshopt_compression.
export function mkGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

// Parsed-GLTF cache: loader.load re-parses the whole file per call, so a
// roomful of same-rig remotes paid N× the meshopt decode + N× GPU uploads
// of identical geometry/textures. Cache the parse; callers clone what
// they need (SkeletonUtils for skinned rigs). A rejected parse evicts
// itself so a transient failure doesn't poison every later requester.
const gltfCache = new Map<string, Promise<GLTF>>();

export function loadGltfCached(loader: GLTFLoader, url: string): Promise<GLTF> {
  let p = gltfCache.get(url);
  if (!p) {
    p = new Promise<GLTF>((res, rej) => loader.load(url, res, undefined, rej));
    gltfCache.set(url, p);
    p.catch(() => { if (gltfCache.get(url) === p) gltfCache.delete(url); });
  }
  return p;
}
