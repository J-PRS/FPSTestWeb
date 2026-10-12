const STABLE_FRAME_SECONDS = 0.026;
const REQUIRED_STABLE_FRAMES = 45;
const MAX_WARMUP_FRAMES = 240;

export class BootWarmup {
  private stableFrames = 0;
  private totalFrames = 0;
  private ready = false;
  private resolvers: (() => void)[] = [];

  get released(): boolean { return this.ready; }

  tick(frameSeconds: number): void {
    if (this.ready) {return;}
    this.totalFrames += 1;
    this.stableFrames = Number.isFinite(frameSeconds) && frameSeconds > 0 && frameSeconds < STABLE_FRAME_SECONDS
      ? this.stableFrames + 1 : 0;
    if (this.stableFrames < REQUIRED_STABLE_FRAMES && this.totalFrames < MAX_WARMUP_FRAMES) {return;}
    // Readiness belongs to the frames, not to the timing of an async caller.
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
