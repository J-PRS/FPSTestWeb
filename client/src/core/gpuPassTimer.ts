import type * as THREE from 'three';
import { Logger } from './Logger.ts';
import { gpuTimerSuppressFrame } from './gpuTimer.ts';

/** Per-pass GPU timing (?gpuperf) — EXT_disjoint_timer_query_webgl2
 *  wrapped around each composer pass, so the report answers 'which
 *  pass costs what' in real GPU ms rather than JS submit time.
 *  Results land a few frames late (GPU async) — drain() polls
 *  non-blockingly and folds finished queries into per-label stats.
 *  Chrome fuzzes these post-Spectre unless launched with
 *  --enable-webgl-developer-extensions — the harness passes it. */

interface PassStats { n: number; sumMs: number; maxMs: number }
interface PendingQuery { query: WebGLQuery; label: string }

const stats = new Map<string, PassStats>();
const pending: PendingQuery[] = [];
let gl: WebGL2RenderingContext | null = null;
let ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
let disjointFrames = 0;

export function gpuPassInit(renderer: THREE.WebGLRenderer): boolean {
  const ctx = renderer.getContext();
  if (!(ctx instanceof WebGL2RenderingContext)) {return false;}
  const e = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!e) {return false;}
  gl = ctx; ext = e;
  gpuTimerSuppressFrame(); // pass queries would nest inside the frame query
  return true;
}

/** Wrap a callable so each invocation runs inside a timer query for
 *  `label`. Installed only under ?gpuperf. */
export function gpuPassWrap<T extends unknown[]>(label: string, fn: (...args: T) => void): (...args: T) => void {
  return (...args: T): void => {
    if (gl && ext && pending.length < 64) {
      const query = gl.createQuery();
      if (query) {
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        try { fn(...args); } finally {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          pending.push({ query, label });
        }
        return;
      }
    }
    fn(...args);
  };
}

/** Poll finished queries — call once per frame. A disjoint event
 *  (GPU reset) invalidates in-flight results; counted, not trusted. */
export function gpuPassDrain(): void {
  if (!gl || !ext) {return;}
  if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {disjointFrames += 1; pending.length = 0; return;}
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const p = pending[i]!;
    if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) {continue;}
    const ms = (gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number) / 1e6;
    const s = stats.get(p.label) ?? { n: 0, sumMs: 0, maxMs: 0 };
    s.n += 1; s.sumMs += ms;
    if (ms > s.maxMs) {s.maxMs = ms;}
    stats.set(p.label, s);
    gl.deleteQuery(p.query);
    pending.splice(i, 1);
  }
}

/** avg/max per pass, sorted desc — window.__gpuPass under ?gpuperf. */
export function gpuPassReport(): { pass: string; avgMs: number; maxMs: number; n: number }[] {
  return [...stats.entries()]
    .map(([pass, s]) => ({ pass, avgMs: s.sumMs / s.n, maxMs: s.maxMs, n: s.n }))
    .sort((a, b) => b.avgMs - a.avgMs);
}

export function gpuPassLog(): void {
  for (const r of gpuPassReport()) {
    Logger.info(`[gpupass] ${r.pass} avg=${r.avgMs.toFixed(2)}ms max=${r.maxMs.toFixed(2)}ms n=${r.n}`);
  }
  if (disjointFrames) {Logger.info(`[gpupass] disjointFrames=${disjointFrames}`);}
}
