const STABLE_FRAME_SECONDS = 0.026;
const REQUIRED_STABLE_FRAMES = 15;
// Wall-clock cap, NOT a frame count - a stalled frame (a 40s sync shader
// compile lands in one rAF) stretches frame budgets arbitrarily, which is
// how the veil could outlive the actual hitch.
const MAX_WARMUP_SECONDS = 4;

export class BootWarmup {
  private stableFrames = 0;
  private elapsed = 0;
  private ready = false;
  private resolvers: (() => void)[] = [];

  get released(): boolean { return this.ready; }

  tick(frameSeconds: number): void {
    if (this.ready) {return;}
    const dt = Number.isFinite(frameSeconds) && frameSeconds > 0 ? frameSeconds : 0;
    this.elapsed += dt;
    this.stableFrames = dt > 0 && dt < STABLE_FRAME_SECONDS
      ? this.stableFrames + 1 : 0;
    if (this.stableFrames < REQUIRED_STABLE_FRAMES && this.elapsed < MAX_WARMUP_SECONDS) {return;}
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
