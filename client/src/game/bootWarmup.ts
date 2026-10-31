const STABLE_FRAME_SECONDS = 0.035;
const WINDOW_SIZE = 30;
const REQUIRED_STABLE = 18; // 60% of the window
// Wall-clock cap, NOT a frame count - a stalled frame (a 40s sync shader
// compile lands in one rAF) stretches frame budgets arbitrarily, which is
// how the veil could outlive the actual hitch.
const MAX_WARMUP_SECONDS = 4;
// Post-veil observation window: the warmup can release during a quiet
// stretch and the first real frames after are exactly where deferred
// compiles/loads land - watch pacing past the drop and report, rather
// than trusting the release window itself was representative.
const OBSERVE_SECONDS = 10;
const HITCH_FRAME_SECONDS = 0.05;

import { ChildLogger } from '../core/Logger.js';
const logger = new ChildLogger('BootWarmup');

/** Heavy work still in flight that the veil must hide (GLB retarget
 *  bake ~7s on main thread). Callers ++ at start, -- at settle;
 *  the veil can't drop while it's nonzero - a "stable" frame window
 *  between two sync blocks isn't stability. */
export const pendingHeavy = { n: 0 };

export class BootWarmup {
  private window: number[] = [];
  private elapsed = 0;
  private ready = false;
  private wasPending = false;
  private resolvers: (() => void)[] = [];
  // Post-release observation state - null until released, then a rolling
  // budget of remaining seconds + anomaly counters for the summary.
  private observeS = 0;
  private worst = 0;
  private p50Samples: number[] = [];
  private hitches: { dt: number; at: number }[] = [];

  get released(): boolean { return this.ready; }

  tick(frameSeconds: number): void {
    if (this.ready) {
      const dt = Number.isFinite(frameSeconds) && frameSeconds > 0 ? frameSeconds : 0;
      if (dt <= 0 || this.observeS >= OBSERVE_SECONDS) {return;}
      this.observeS += dt;
      this.worst = Math.max(this.worst, dt);
      this.p50Samples.push(dt);
      if (dt > HITCH_FRAME_SECONDS) {this.hitches.push({ dt, at: this.observeS });}
      if (this.observeS >= OBSERVE_SECONDS) {this.report();}
      return;
    }
    const dt = Number.isFinite(frameSeconds) && frameSeconds > 0 ? frameSeconds : 0;
    this.elapsed += dt;
    const stable = dt > 0 && dt < STABLE_FRAME_SECONDS ? 1 : 0;
    this.window.push(stable);
    if (this.window.length > WINDOW_SIZE) {this.window.shift();}
    const stableCount = this.window.reduce((a, b) => a + b, 0);
    if (this.window.length < WINDOW_SIZE) {return;} // wait for full window
    // Max cap holds while heavy loads pend - the veil stays up for the
    // retarget bake rather than dropping into a 7s first-input freeze.
    // Hard ceiling: a wedged loader can't hold the veil hostage forever.
    const MAX_HEAVY_WAIT = 20;
    if (pendingHeavy.n > 0 && this.elapsed < MAX_HEAVY_WAIT) {
      // The instant pending clears the veil must NOT drop on a window
      // full of between-block frames - reset so release needs a fresh
      // stable window AFTER the tail work (setTimeout bakes, clone
      // refills) has run, not during the breath between blocks.
      this.wasPending = true;
      return;
    }
    if (this.wasPending) { this.wasPending = false; this.window.length = 0; return; }
    if (stableCount < REQUIRED_STABLE && this.elapsed < MAX_WARMUP_SECONDS) {return;}
    this.ready = true;
    this.observeS = 0;
    const {resolvers} = this;
    this.resolvers = [];
    for (const resolve of resolvers) {resolve();}
  }

  /** Post-veil summary: worst frame, p50/p95, and every >50ms hitch in
   *  the first OBSERVE_SECONDS after release - the anomalies a too-early
   *  veil drop would have hidden. */
  private report(): void {
    const sorted = [...this.p50Samples].sort((a, b) => a - b);
    const p = (q: number): number => (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0) * 1000;
    const top = this.hitches.toSorted((a, b) => b.dt - a.dt).slice(0, 5)
      .map((h) => `${(h.dt * 1000).toFixed(0)}ms@${h.at.toFixed(1)}s`).join(' ');
    const n = this.hitches.length;
    const line = `post-veil ${OBSERVE_SECONDS}s pacing: p50=${p(0.5).toFixed(1)}ms p95=${p(0.95).toFixed(1)}ms worst=${(this.worst * 1000).toFixed(1)}ms hitches=${n}${n > 0 ? ` top=${top}` : ''}`;
    if (n === 0) {logger.info(line);} else {logger.warn(line);}
  }

  whenStable(): Promise<void> {
    if (this.ready) {return Promise.resolve();}
    return new Promise((resolve): void => {this.resolvers.push(resolve);});
  }
}
