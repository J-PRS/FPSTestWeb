const FF_DT = 1 / 60;

// Advance an entity from its event timestamp to the seek time in fixed steps.
// Leaf module — every playback applier needs this, and importing it from
// playbackReconstruction created an import cycle (reconstruction → appliers
// → reconstruction).
export function fastForward(ffTime: number, alive: () => boolean, step: (dt: number) => void): void {
  let rem = ffTime;
  while (rem > 0 && alive()) {
    const s = Math.min(FF_DT, rem);
    step(s);
    rem -= s;
  }
}
