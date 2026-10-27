const STABLE_FRAME_SECONDS = 0.035;
const WINDOW_SIZE = 30;
const REQUIRED_STABLE = 18; // 60% of the window
// Wall-clock cap, NOT a frame count - a stalled frame (a 40s sync shader
// compile lands in one rAF) stretches frame budgets arbitrarily, which is
// how the veil could outlive the actual hitch.
const MAX_WARMUP_SECONDS = 4;

export class BootWarmup {
  private window: number[] = [];
  private elapsed = 0;
  private ready = false;
  private resolvers: (() => void)[] = [];

  get released(): boolean { return this.ready; }

  tick(frameSeconds: number): void {
    if (this.ready) {return;}
    const dt = Number.isFinite(frameSeconds) && frameSeconds > 0 ? frameSeconds : 0;
    this.elapsed += dt;
    const stable = dt > 0 && dt < STABLE_FRAME_SECONDS ? 1 : 0;
    this.window.push(stable);
    if (this.window.length > WINDOW_SIZE) {this.window.shift();}
    const stableCount = this.window.reduce((a, b) => a + b, 0);
    if (this.window.length < WINDOW_SIZE) {return;} // wait for full window
    if (stableCount < REQUIRED_STABLE && this.elapsed < MAX_WARMUP_SECONDS) {return;}
    this.ready = true;
    const {resolvers} = this;
    this.resolvers = [];
    for (const resolve of resolvers) {resolve();}
  }

  whenStable(): Promise<void> {
    if (this.ready) {return Promise.resolve();}
    return new Promise((resolve): void => {this.resolvers.push(resolve);});
  }
}
