/**
 * renderScan — staged render-cost breakdown for profiling. Renders extra
 * bursts on top of the live loop, one stage at a time, and reports per-
 * stage CPU submit ms, draw calls, triangles, and GPU ms (when the
 * EXT_disjoint_timer_query_webgl2 ext is present). Deltas between stages
 * isolate a pass's real cost:
 *   shadow pass  = sceneShadow - scene
 *   post/composer = full - sceneShadow - viewmodel
 * A stale shadow map is used for the no-shadow stage (autoUpdate off) so
 * materials don't recompile mid-scan.
 */
import * as THREE from 'three';
import type { GameLoopDeps } from './gameLoop.js';

interface StageResult {
  cpuMs: number;
  calls: number;
  tris: number;
  gpuMs?: number;
}

interface GlTimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** One async GPU timer query per frame; results resolve at scan end. */
function makeTimer(r: THREE.WebGLRenderer): { begin(): void; end(): void; read(): Promise<number | null> } {
  const gl = r.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as GlTimerExt | null;
  const queries: WebGLQuery[] = [];
  if (!ext) {return { begin() {}, end() {}, async read() { return null; } };}
  return {
    begin() {
      const q = gl.createQuery();
      if (q) { queries.push(q); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    },
    end() { gl.endQuery(ext.TIME_ELAPSED_EXT); },
    async read() {
      const deadline = performance.now() + 3000;
      let total = 0, n = 0;
      for (const q of queries) {
        while (performance.now() < deadline &&
               !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          await new Promise(res => setTimeout(res, 5));
        }
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          total += gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
          n++;
        }
        gl.deleteQuery(q);
      }
      return n ? total / n / 1e6 : null;
    },
  };
}

async function sampleStage(run: () => void, frames: number, r: THREE.WebGLRenderer): Promise<StageResult> {
  const timer = makeTimer(r);
  let cpu = 0, calls = 0, tris = 0;
  // Two warmup frames first: lazy shader compiles and buffer uploads would
  // otherwise poison the first measured frame of every stage.
  for (let i = 0; i < 2; i++) {run();}
  for (let i = 0; i < frames; i++) {
    r.info.reset();
    const t0 = performance.now();
    timer.begin();
    run();
    timer.end();
    cpu += performance.now() - t0;
    calls = r.info.render.calls;
    tris = r.info.render.triangles;
  }
  const gpuMs = await timer.read();
  const out: StageResult = { cpuMs: Number((cpu / frames).toFixed(3)), calls, tris };
  if (gpuMs !== null) {out.gpuMs = Number(gpuMs.toFixed(3));}
  return out;
}

export function createRenderScan(deps: GameLoopDeps) {
  return async (framesPerStage = 40): Promise<Record<string, StageResult>> => {
    const { rendererSetup, sceneSetup, camera } = deps;
    const r = rendererSetup.renderer;
    const shadow = r.shadowMap;
    const prevAutoUpdate = shadow.autoUpdate;
    const prevInfoReset = r.info.autoReset;
    r.info.autoReset = false;
    try {
      const bareScene = () => r.render(sceneSetup.scene, camera);
      const out: Record<string, StageResult> = {};
      // Stage 1: scene color+depth only, stale shadow map — no shadow pass.
      shadow.autoUpdate = false; shadow.needsUpdate = false;
      out.scene = await sampleStage(bareScene, framesPerStage, r);
      // Stage 2: same but the shadow map re-renders every frame.
      out.sceneShadow = await sampleStage(() => { shadow.needsUpdate = true; bareScene(); }, framesPerStage, r);
      // Stage 3: the real pipeline — composer or bare depending on mode.
      shadow.autoUpdate = prevAutoUpdate; shadow.needsUpdate = true;
      out.full = await sampleStage(() => rendererSetup.render(0.016), framesPerStage, r);
      // Stage 4: viewmodel overlay pass on its own.
      const vmScene = deps.vmScene(), vmCam = deps.vmCamera();
      vmCam.quaternion.copy(camera.quaternion);
      out.viewmodel = await sampleStage(() => { r.clearDepth(); r.render(vmScene, vmCam); }, framesPerStage, r);
      return out;
    } finally {
      shadow.autoUpdate = prevAutoUpdate;
      r.info.autoReset = prevInfoReset;
      r.info.reset();
    }
  };
}
