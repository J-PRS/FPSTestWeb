/* oxlint-disable unicorn/require-post-message-target-origin -- Worker postMessage has no targetOrigin param */
// Worker-backed GLB load — one worker, request map by id, cache slot
// compatible with loadGltfCached (same Promise<GLTF> shape). Rebuild on
// main wraps the transferred arrays — no decode cost here.
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { rebuildGltf } from './glbSer.js';
import { ChildLogger } from './core/Logger.js';

const logger = new ChildLogger('GlbW');

/** true when worker GLB loading is viable (Chrome/FF workers + vite's
 *  module-worker build). Tests/SSR have no Worker — callers fall back
 *  to the main-thread loader. */
export const glbWorkerOk = typeof Worker !== 'undefined' && typeof createImageBitmap !== 'undefined'
  && !new URLSearchParams(globalThis.location?.search ?? '').has('glbnw');

let seq = 0;
const pending = new Map<number, { res: (g: GLTF) => void; rej: (e: Error) => void }>();

let worker: Worker | null = null;
if (glbWorkerOk) {
  // Eager: the worker's own module-fetch/boot hides behind page load —
  // spawning it at import means it's parse-ready by the first GLB call.
  worker = new Worker(new URL('./glbWorker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent): void => {
    const m = e.data as { id: number; ok: boolean; code?: string; data?: Parameters<typeof rebuildGltf>[0]; err?: string };
    const p = pending.get(m.id);
    if (!p) {return;}
    pending.delete(m.id);
    if (!m.ok || !m.data) {
      const err = new Error(m.err ?? 'glb worker parse failed') as Error & { code?: string };
      err.code = m.code ?? 'parse';
      p.rej(err);
      return;
    }
    try {
      p.res(rebuildGltf(m.data));
    } catch (error) {
      p.rej(error instanceof Error ? error : new Error(String(error)));
    }
  });
  worker.addEventListener('error', (e): void => { logger.error('glb worker error', { msg: e.message }); });
}

export function loadGlbWorker(url: string): Promise<GLTF> {
  return new Promise<GLTF>((res, rej): void => {
    if (!worker) {rej(new Error('glb worker unavailable')); return;}
    seq += 1;
    const id = seq;
    pending.set(id, { res, rej });
    worker.postMessage({ id, url });
  });
}
