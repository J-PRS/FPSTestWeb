/**
 * gpuTimer — real GPU-side frame time via EXT_disjoint_timer_query_webgl2.
 * CPU render-ms only counts how long the driver took to ACCEPT commands;
 * when the GPU is the wall, the queue fills and that wait shows up
 * elsewhere. The timer query measures the raster itself — one query per
 * frame wrapped around the whole submission, harvested once it finishes
 * (GPU async — results land a frame or two later).
 */
import type * as THREE from 'three';

type TimerExt = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

let ext: TimerExt | null | undefined = undefined;
let gl: WebGL2RenderingContext | null = null;
const pending: WebGLQuery[] = [];
let active: WebGLQuery | null = null;
let lastNs = 0;
let disjointSeen = false;

function harvest(): void {
  if (!gl) {return;}
  // A disjoint event (GPU reset, context loss) invalidates every in-flight
  // result — drop the queue and report it rather than trusting a stale ms.
  if (gl.getParameter(ext!.GPU_DISJOINT_EXT)) { pending.length = 0; disjointSeen = true; }
  while (pending.length > 0 && gl.getQueryParameter(pending[0]!, gl.QUERY_RESULT_AVAILABLE)) {
    const q = pending.shift()!;
    lastNs = Number(gl.getQueryParameter(q, gl.QUERY_RESULT));
    gl.deleteQuery(q);
  }
}

export function gpuBegin(renderer: THREE.WebGLRenderer): void {
  if (ext === undefined) {
    const ctx = renderer.getContext();
    gl = ctx instanceof WebGL2RenderingContext ? ctx : null;
    ext = gl ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) : null;
  }
  if (!ext || !gl) {return;}
  harvest();
  const q = gl.createQuery();
  if (!q) {return;}
  // A query left open by an aborted frame must be closed before a new
  // one starts — nested TIME_ELAPSED queries are illegal.
  if (active) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); }
  gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
  active = q;
}

export function gpuEnd(): void {
  if (!active || !ext || !gl) {return;}
  gl.endQuery(ext.TIME_ELAPSED_EXT);
  pending.push(active);
  active = null;
}

/** GPU raster ms for the most recent completed frame (0 while the first
 *  queries are still in flight or the ext is missing). */
export function gpuMs(): number { return lastNs / 1e6; }

export function gpuTimerSupported(): boolean { return Boolean(ext); }
export function gpuTimerDisjoint(): boolean { return disjointSeen; }
