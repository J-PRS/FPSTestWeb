/**
 * poolPolicy — the shared capacity-decay rule for the instanced pools
 * (gibs, swarm slots, blob shadows). A burst spike grows the buffers;
 * once occupancy has held under a quarter for the idle window the pool
 * shrinks back toward its floor so peak memory isn't pinned forever.
 * Each pool owns the repack/resize mechanics — this is only the
 * "when and to what" decision plus the idle clock.
 */

/** How long under quarter-occupancy before a pool gives capacity back. */
export const IDLE_SHRINK_MS = 30_000;

export class CapGovernor {
  /** Last time occupancy reached a quarter of capacity — the clock that
   *  keeps a steady-but-sparse pool from shrinking mid-stream. */
  private idleAt = 0;

  /** Returns the capacity to shrink to (smallest floor-multiple covering
   *  2× live), or null to hold. */
  shrinkTarget(live: number, cap: number, floor: number, now: number): number | null {
    if (live * 4 >= cap) { this.idleAt = now; return null; }
    if (cap <= floor || now - this.idleAt < IDLE_SHRINK_MS) {return null;}
    const target = Math.max(floor, Math.ceil((live * 2) / floor) * floor);
    if (target >= cap) { this.idleAt = now; return null; }
    return target;
  }

  /** Restart the idle clock after a shrink is applied. */
  shrunk(now: number): void { this.idleAt = now; }
}
