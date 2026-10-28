/* oxlint-disable unicorn/require-post-message-target-origin -- WorkerGlobalScope postMessage has no targetOrigin param */
// GLB parse worker — the ~1.7s meshopt-decode + scene-build block that
// owned main during boot (load:rigParse) runs here; main rebuilds real
// THREE objects from transferred arrays (glbSer.rebuildGltf).
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { serializeGltf } from './glbSer.js';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

async function load(id: number, url: string): Promise<void> {
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    const gltf = await loader.parseAsync(buf, url.slice(0, url.lastIndexOf('/') + 1));
    const { data, transfers } = serializeGltf(gltf);
    (self as unknown as Worker).postMessage({ id, ok: true, data }, transfers);
  } catch (error) {
    // 'ser' = we parsed but can't serialize (morphs, weird attrs) — main
    // can still load it on its own loader; 'parse' = genuinely bad file.
    const ser = error instanceof Error && (error.message.includes('glbSer') || (error as { __ser?: boolean }).__ser === true) ? 'ser' : 'parse';
    (self as unknown as Worker).postMessage({ id, ok: false, code: ser, err: error instanceof Error ? error.message : String(error) });
  }
}

self.addEventListener('message', (e: MessageEvent<{ id: number; url: string }>): void => {
  const { id, url } = e.data;
  load(id, url).catch((): void => { /* load() self-reports errors */ });
});
