/**
 * Performance profiler for demo recording and playback.
 * Tracks CPU time, memory usage, and frame rates.
 */
export class DemoProfiler {
  private recordingStartTime: number = 0;
  private recordingTotalTime: number = 0;
  private recordingFrameCount: number = 0;
  private recordingMaxFrameTime: number = 0;
  private recordingMinFrameTime: number = Infinity;

  private playbackStartTime: number = 0;
  private playbackTotalTime: number = 0;
  private playbackFrameCount: number = 0;
  private playbackMaxFrameTime: number = 0;
  private playbackMinFrameTime: number = Infinity;

  private enabled: boolean = false;

  /**
   * Enable or disable profiling.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if profiling is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Start recording profiling.
   */
  startRecordingProfiling(): void {
    if (!this.enabled) {
      return;
    }

    this.recordingStartTime = performance.now();
    this.recordingTotalTime = 0;
    this.recordingFrameCount = 0;
    this.recordingMaxFrameTime = 0;
    this.recordingMinFrameTime = Infinity;
  }

  /**
   * Record a frame during recording.
   * @param frameTime - Time taken to process this frame (ms)
   */
  recordRecordingFrame(frameTime: number): void {
    if (!this.enabled) {
      return;
    }

    this.recordingFrameCount++;
    this.recordingTotalTime += frameTime;
    this.recordingMaxFrameTime = Math.max(this.recordingMaxFrameTime, frameTime);
    this.recordingMinFrameTime = Math.min(this.recordingMinFrameTime, frameTime);
  }

  /**
   * Stop recording profiling.
   */
  stopRecordingProfiling(): DemoProfile {
    if (!this.enabled) {
      return this.createEmptyProfile();
    }

    const totalTime = performance.now() - this.recordingStartTime;
    const avgFrameTime = this.recordingFrameCount > 0 ? this.recordingTotalTime / this.recordingFrameCount : 0;
    const fps = this.recordingFrameCount > 0 ? (this.recordingFrameCount / (totalTime / 1000)) : 0;

    return {
      type: 'recording',
      totalTime,
      frameCount: this.recordingFrameCount,
      avgFrameTime,
      maxFrameTime: this.recordingMaxFrameTime,
      minFrameTime: this.recordingMinFrameTime === Infinity ? 0 : this.recordingMinFrameTime,
      fps,
      overheadPercent: this.calculateOverheadPercent(avgFrameTime),
    };
  }

  /**
   * Start playback profiling.
   */
  startPlaybackProfiling(): void {
    if (!this.enabled) {
      return;
    }

    this.playbackStartTime = performance.now();
    this.playbackTotalTime = 0;
    this.playbackFrameCount = 0;
    this.playbackMaxFrameTime = 0;
    this.playbackMinFrameTime = Infinity;
  }

  /**
   * Record a frame during playback.
   * @param frameTime - Time taken to process this frame (ms)
   */
  recordPlaybackFrame(frameTime: number): void {
    if (!this.enabled) {
      return;
    }

    this.playbackFrameCount++;
    this.playbackTotalTime += frameTime;
    this.playbackMaxFrameTime = Math.max(this.playbackMaxFrameTime, frameTime);
    this.playbackMinFrameTime = Math.min(this.playbackMinFrameTime, frameTime);
  }

  /**
   * Stop playback profiling.
   */
  stopPlaybackProfiling(): DemoProfile {
    if (!this.enabled) {
      return this.createEmptyProfile();
    }

    const totalTime = performance.now() - this.playbackStartTime;
    const avgFrameTime = this.playbackFrameCount > 0 ? this.playbackTotalTime / this.playbackFrameCount : 0;
    const fps = this.playbackFrameCount > 0 ? (this.playbackFrameCount / (totalTime / 1000)) : 0;

    return {
      type: 'playback',
      totalTime,
      frameCount: this.playbackFrameCount,
      avgFrameTime,
      maxFrameTime: this.playbackMaxFrameTime,
      minFrameTime: this.playbackMinFrameTime === Infinity ? 0 : this.playbackMinFrameTime,
      fps,
      overheadPercent: this.calculateOverheadPercent(avgFrameTime),
    };
  }

  /**
   * Calculate overhead percentage based on frame time.
   * Assumes 16.67ms target (60 FPS).
   */
  private calculateOverheadPercent(avgFrameTime: number): number {
    const targetFrameTime = 16.67; // 60 FPS
    return (avgFrameTime / targetFrameTime) * 100;
  }

  /**
   * Create an empty profile.
   */
  private createEmptyProfile(): DemoProfile {
    return {
      type: 'none',
      totalTime: 0,
      frameCount: 0,
      avgFrameTime: 0,
      maxFrameTime: 0,
      minFrameTime: 0,
      fps: 0,
      overheadPercent: 0,
    };
  }

  /**
   * Get current recording profile (without stopping).
   */
  getCurrentRecordingProfile(): DemoProfile {
    if (!this.enabled) {
      return this.createEmptyProfile();
    }

    const totalTime = performance.now() - this.recordingStartTime;
    const avgFrameTime = this.recordingFrameCount > 0 ? this.recordingTotalTime / this.recordingFrameCount : 0;
    const fps = this.recordingFrameCount > 0 ? (this.recordingFrameCount / (totalTime / 1000)) : 0;

    return {
      type: 'recording',
      totalTime,
      frameCount: this.recordingFrameCount,
      avgFrameTime,
      maxFrameTime: this.recordingMaxFrameTime,
      minFrameTime: this.recordingMinFrameTime === Infinity ? 0 : this.recordingMinFrameTime,
      fps,
      overheadPercent: this.calculateOverheadPercent(avgFrameTime),
    };
  }

  /**
   * Get current playback profile (without stopping).
   */
  getCurrentPlaybackProfile(): DemoProfile {
    if (!this.enabled) {
      return this.createEmptyProfile();
    }

    const totalTime = performance.now() - this.playbackStartTime;
    const avgFrameTime = this.playbackFrameCount > 0 ? this.playbackTotalTime / this.playbackFrameCount : 0;
    const fps = this.playbackFrameCount > 0 ? (this.playbackFrameCount / (totalTime / 1000)) : 0;

    return {
      type: 'playback',
      totalTime,
      frameCount: this.playbackFrameCount,
      avgFrameTime,
      maxFrameTime: this.playbackMaxFrameTime,
      minFrameTime: this.playbackMinFrameTime === Infinity ? 0 : this.playbackMinFrameTime,
      fps,
      overheadPercent: this.calculateOverheadPercent(avgFrameTime),
    };
  }

  /**
   * Reset all profiling data.
   */
  reset(): void {
    this.recordingStartTime = 0;
    this.recordingTotalTime = 0;
    this.recordingFrameCount = 0;
    this.recordingMaxFrameTime = 0;
    this.recordingMinFrameTime = Infinity;

    this.playbackStartTime = 0;
    this.playbackTotalTime = 0;
    this.playbackFrameCount = 0;
    this.playbackMaxFrameTime = 0;
    this.playbackMinFrameTime = Infinity;
  }
}

/**
 * Profile data structure.
 */
export interface DemoProfile {
  /** Profile type */
  type: 'recording' | 'playback' | 'none';
  /** Total time in ms */
  totalTime: number;
  /** Number of frames */
  frameCount: number;
  /** Average frame time in ms */
  avgFrameTime: number;
  /** Maximum frame time in ms */
  maxFrameTime: number;
  /** Minimum frame time in ms */
  minFrameTime: number;
  /** Frames per second */
  fps: number;
  /** Overhead percentage (relative to 60 FPS target) */
  overheadPercent: number;
}

/**
 * Format profile data for display.
 */
export function formatProfile(profile: DemoProfile): string {
  if (profile.type === 'none') {
    return 'No profiling data';
  }

  return [
    `${profile.type === 'recording' ? 'Recording' : 'Playback'} Profile:`,
    `  Total time: ${profile.totalTime.toFixed(2)}ms`,
    `  Frames: ${profile.frameCount}`,
    `  Avg frame time: ${profile.avgFrameTime.toFixed(3)}ms`,
    `  Max frame time: ${profile.maxFrameTime.toFixed(3)}ms`,
    `  Min frame time: ${profile.minFrameTime.toFixed(3)}ms`,
    `  FPS: ${profile.fps.toFixed(1)}`,
    `  Overhead: ${profile.overheadPercent.toFixed(1)}%`,
  ].join('\n');
}
