// FrameBudget — the general form of the bucket stagger used by the
// server sims and the species LOD: iterable work runs until a ms quota
// is spent, then yields and resumes at the cursor next frame. Anything
// "expensive but not subtle" (spawn waves, debris storms, structure
// sweeps, ambient population passes) opts in by name; frames and
// physics stay untouched because they're per-entity state machines,
// not batch jobs.
//
// Usage:
//   budget.each('spawnwave', pendingSpawns, 2.0, (job) => spawn(job));
// Resumable semantics: fn receives items in order; work stops mid-list
// when the quota trips and picks up where it left off on the next call.
// Items consumed are spliced out in-place (caller-owned array shrinks).

export interface FrameBudget {
  /** Process items from the FRONT of the caller's array until msCap is
   *  exhausted or the list drains. Returns remaining count. Mutates the
   *  array — completed items are shifted out so the same array passed
   *  next frame resumes correctly. */
  each<T>(name: string, items: T[], msCap: number, fn: (item: T) => void): number;
  /** Periodic work: run fn at most once per intervalMs, phased by name
   *  hash so several sweeps don't align on the same frame. For jobs that
   *  must see the WHOLE list (sweeps, not queues) — minimap blips,
   *  census passes, cache invalidations. */
  sweep(name: string, intervalMs: number, fn: () => void): boolean;
  /** EMA stats per queue name — item throughput + worst single-item cost,
   *  so the profiler can see whether a budgeted queue is keeping up. */
  stats(): Record<string, { perFrame: number; worstItemMs: number; backlog: number }>;
  reset(name: string): void;
}

export function createFrameBudget(): FrameBudget {
  const stats = new Map<string, { done: number; calls: number; worst: number; backlog: number }>();

  function each<T>(name: string, items: T[], msCap: number, fn: (item: T) => void): number {
    const t0 = performance.now();
    let done = 0;
    const s = stats.get(name) ?? { done: 0, calls: 0, worst: 0, backlog: 0 };
    stats.set(name, s);
    while (done < items.length) {
      const i0 = performance.now();
      fn(items[done]!);
      const itemMs = performance.now() - i0;
      done++;
      if (itemMs > s.worst) s.worst = itemMs;
      if (performance.now() - t0 >= msCap && done < items.length) break;
    }
    // One O(n) splice for the completed prefix — shift()-per-item would
    // be O(n²) on a big backlog.
    items.splice(0, done);
    s.done += done; s.calls++; s.backlog = items.length;
    return items.length;
  }

  const sweeps = new Map<string, number>();

  function sweep(name: string, intervalMs: number, fn: () => void): boolean {
    let last = sweeps.get(name);
    if (last === undefined) {
      // First-run phase — a cheap name hash spaces sweeps so three
      // 40ms jobs don't all fire on frame N together.
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
      last = performance.now() - intervalMs + (Math.abs(h) % Math.max(1, intervalMs));
      sweeps.set(name, last);
    }
    const now = performance.now();
    if (now - last < intervalMs) return false;
    sweeps.set(name, now);
    fn();
    return true;
  }

  return {
    each,
    sweep,
    stats() {
      const out: Record<string, { perFrame: number; worstItemMs: number; backlog: number }> = {};
      for (const [k, s] of stats) {
        out[k] = {
          perFrame: s.calls > 0 ? +(s.done / s.calls).toFixed(2) : 0,
          worstItemMs: +s.worst.toFixed(3),
          backlog: s.backlog,
        };
      }
      return out;
    },
    reset(name: string) { stats.delete(name); },
  };
}
