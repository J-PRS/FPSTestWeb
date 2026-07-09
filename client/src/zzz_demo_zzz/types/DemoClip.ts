/**
 * Demo clip segment for cool hit extraction.
 */
export interface DemoClip {
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Start frame index */
  startFrameIndex: number;
  /** End frame index */
  endFrameIndex: number;
  /** Clip description */
  description: string;
}

/**
 * Calculate the duration of a clip.
 */
export function getClipDuration(clip: DemoClip): number {
  return clip.endTime - clip.startTime;
}

/**
 * Calculate the number of frames in a clip.
 */
export function getClipFrameCount(clip: DemoClip): number {
  return clip.endFrameIndex - clip.startFrameIndex + 1;
}

/**
 * Create a default DemoClip.
 */
export function createDefaultDemoClip(): DemoClip {
  return {
    startTime: 0,
    endTime: 0,
    startFrameIndex: 0,
    endFrameIndex: 0,
    description: '',
  };
}
