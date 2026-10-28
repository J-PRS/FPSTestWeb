import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { glbWorkerOk, loadGlbWorker } from './glbWorkerLoad.js';
import { ChildLogger } from './core/Logger.js';

const logger = new ChildLogger('Gltf');

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

/** Worker-first GLB load. The meshopt decode + scene build is the ~1.7s
 *  block that owned main at boot (load:rigParse) — in a worker it costs
 *  main only the BufferGeometry wrap. A 'ser' rejection means the file
 *  has a shape the serializer can't carry — fall back to the caller's
 *  loader for it (and only it — parse errors stay fatal). */
export function loadGlbOrMain(loader: GLTFLoader, url: string): Promise<GLTF> {
  if (!glbWorkerOk) {
    return new Promise<GLTF>((res, rej): void => loader.load(url, res, undefined, rej));
  }
  return loadGlbWorker(url).catch((error: Error & { code?: string }): Promise<GLTF> => {
    if (error.code !== 'ser') {throw error;}
    logger.warn(`glb worker can't carry ${url} — main-thread parse`, { err: error.message });
    return new Promise<GLTF>((res, rej): void => loader.load(url, res, undefined, rej));
  });
}

export function loadGltfCached(loader: GLTFLoader, url: string): Promise<GLTF> {
  let p = gltfCache.get(url);
  if (!p) {
    p = loadGlbOrMain(loader, url);
    gltfCache.set(url, p);
    p.catch((): void => { if (gltfCache.get(url) === p) {gltfCache.delete(url);} });
  }
  return p;
}
