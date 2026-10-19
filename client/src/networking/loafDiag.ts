// Long Animation Frames observer — Chrome 123+. Each LoAF carries
// scripts[] with invoker attribution ('WebSocket.onmessage',
// 'Window.requestAnimationFrame'), which finally answers "did the wire
// stall the frame" instead of inferring it from coalescing spikes.
// Totals since boot + per-invoker blocking ms roll into the Alt+Q dump
// via collectDiag. Unsupported browsers (and jsdom) just report off.
import { registerDiag } from '../core/fxDiag.js';

interface LoafScript {
  invoker?: string;
  duration?: number;
  sourceFunctionName?: string;
}
interface LoafEntry extends PerformanceEntry {
  blockingDuration: number;
  scripts?: LoafScript[];
}

const stats = {
  frames: 0,
  blockingMs: 0,
  worstMs: 0,
  // invoker → {n, ms} — which callback family owns the blocking time.
  byInvoker: new Map<string, { n: number; ms: number }>(),
};

let armed = false;
export function armLoafDiag(): void {
  if (armed || typeof PerformanceObserver === 'undefined'
      || !PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {return;}
  armed = true;
  try {
    new PerformanceObserver((list): void => {
      for (const e of list.getEntries() as LoafEntry[]) {
        stats.frames += 1;
        stats.blockingMs += e.blockingDuration;
        if (e.blockingDuration > stats.worstMs) {stats.worstMs = e.blockingDuration;}
        for (const s of e.scripts ?? []) {
          const k = s.invoker ?? '?';
          const v = stats.byInvoker.get(k) ?? { n: 0, ms: 0 };
          v.n += 1; v.ms += s.duration ?? 0;
          stats.byInvoker.set(k, v);
        }
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch { /* observer construction raced a browser quirk — diag just stays zero */ }
}

registerDiag('loaf', (): { loaf: Record<string, unknown> } => ({
  loaf: {
    frames: stats.frames,
    blockingMs: Math.round(stats.blockingMs),
    worstMs: Math.round(stats.worstMs),
    // Chrome-only perf.memory — heap growth beside LoAF reads answers
    // "GC pressure stall vs wire stall" without opening DevTools.
    heapMb: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1_048_576),
    // Top 4 blocking invokers — the dump answers "render vs wire" at a glance.
    top: [...stats.byInvoker.entries()]
      .toSorted((a, b): number => b[1].ms - a[1].ms)
      .slice(0, 4)
      .map(([k, v]): string => `${k}×${v.n}=${Math.round(v.ms)}ms`),
  },
}));
