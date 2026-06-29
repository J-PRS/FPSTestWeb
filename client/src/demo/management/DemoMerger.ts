import { DemoFile } from '../types/DemoFile.js';
import { DemoFrame } from '../types/DemoFrame.js';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { TargetEvent } from '../types/TargetEvent.js';

/**
 * Merge multiple demo files into a single demo.
 * Useful for combining multiple clips into a single highlight reel.
 */
export class DemoMerger {
  /**
   * Merge multiple demo files sequentially.
   * @param demos - Array of demo files to merge
   * @returns Merged demo file
   */
  static mergeSequential(demos: DemoFile[]): DemoFile {
    if (demos.length === 0) {
      throw new Error('No demos to merge');
    }

    if (demos.length === 1) {
      return demos[0];
    }

    // Start with the first demo
    const merged: DemoFile = {
      header: { ...demos[0].header },
      frames: [],
      projectileEvents: [],
      targetEvents: [],
      playerStartPosition: demos[0].playerStartPosition.clone(),
      playerStartRotation: demos[0].playerStartRotation.clone(),
      playerStartVelocity: demos[0].playerStartVelocity.clone(),
    };

    let timeOffset = 0;
    let frameOffset = 0;
    let projectileIdOffset = 0;
    let targetIdOffset = 0;

    for (const demo of demos) {
      // Merge frames with time offset
      for (const frame of demo.frames) {
        const mergedFrame: DemoFrame = {
          ...frame,
          frameNumber: frame.frameNumber + frameOffset,
          timestamp: frame.timestamp + timeOffset,
          position: frame.position.clone(),
          velocity: frame.velocity.clone(),
          rotation: frame.rotation.clone(),
        };
        merged.frames.push(mergedFrame);
      }

      // Merge projectile events with time and ID offset
      for (const event of demo.projectileEvents) {
        const mergedEvent: ProjectileEvent = {
          ...event,
          timestamp: event.timestamp + timeOffset,
          projectileId: event.projectileId + projectileIdOffset,
          targetId: event.targetId + targetIdOffset,
          position: event.position.clone(),
          velocity: event.velocity.clone(),
          surfaceNormal: event.surfaceNormal.clone(),
          peakPosition: event.peakPosition.clone(),
        };
        merged.projectileEvents.push(mergedEvent);
      }

      // Merge target events with time and ID offset
      for (const event of demo.targetEvents) {
        const mergedEvent: TargetEvent = {
          ...event,
          timestamp: event.timestamp + timeOffset,
          targetId: event.targetId + targetIdOffset,
          position: event.position.clone(),
          velocity: event.velocity.clone(),
          peakPosition: event.peakPosition.clone(),
        };
        merged.targetEvents.push(mergedEvent);
      }

      // Update offsets
      timeOffset += demo.header.duration;
      frameOffset += demo.header.totalFrames;
      projectileIdOffset += demo.header.projectileEvents;
      targetIdOffset += demo.header.targetEvents;
    }

    // Update header
    merged.header.duration = timeOffset;
    merged.header.totalFrames = merged.frames.length;
    merged.header.projectileEvents = merged.projectileEvents.length;
    merged.header.targetEvents = merged.targetEvents.length;
    merged.header.description = `Merged from ${demos.length} demos`;
    merged.header.timestamp = Date.now();

    return merged;
  }

  /**
   * Merge demos with crossfade between segments.
   * @param demos - Array of demo files to merge
   * @param crossfadeDuration - Crossfade duration in seconds
   * @returns Merged demo file
   */
  static mergeWithCrossfade(demos: DemoFile[], crossfadeDuration: number = 1.0): DemoFile {
    if (demos.length === 0) {
      throw new Error('No demos to merge');
    }

    if (demos.length === 1) {
      return demos[0];
    }

    // For simplicity, use sequential merge for now
    // Crossfade would require more complex interpolation logic
    console.warn('[DemoMerger] Crossfade not yet implemented, using sequential merge');
    return DemoMerger.mergeSequential(demos);
  }

  /**
   * Merge demos by interleaving frames (for comparison views).
   * @param demos - Array of demo files to merge
   * @returns Merged demo file with interleaved frames
   */
  static mergeInterleaved(demos: DemoFile[]): DemoFile {
    if (demos.length === 0) {
      throw new Error('No demos to merge');
    }

    if (demos.length === 1) {
      return demos[0];
    }

    // Start with the first demo
    const merged: DemoFile = {
      header: { ...demos[0].header },
      frames: [],
      projectileEvents: [],
      targetEvents: [],
      playerStartPosition: demos[0].playerStartPosition.clone(),
      playerStartRotation: demos[0].playerStartRotation.clone(),
      playerStartVelocity: demos[0].playerStartVelocity.clone(),
    };

    // Find the maximum duration
    const maxDuration = Math.max(...demos.map((d) => d.header.duration));

    // Interleave frames
    let frameIndex = 0;
    while (true) {
      let hasFrames = false;

      for (const demo of demos) {
        if (frameIndex < demo.frames.length) {
          const frame = demo.frames[frameIndex];
          merged.frames.push({
            ...frame,
            frameNumber: merged.frames.length,
            position: frame.position.clone(),
            velocity: frame.velocity.clone(),
            rotation: frame.rotation.clone(),
          });
          hasFrames = true;
        }
      }

      if (!hasFrames) {
        break;
      }

      frameIndex++;
    }

    // Merge all events
    let projectileIdOffset = 0;
    let targetIdOffset = 0;

    for (const demo of demos) {
      for (const event of demo.projectileEvents) {
        merged.projectileEvents.push({
          ...event,
          projectileId: event.projectileId + projectileIdOffset,
          targetId: event.targetId + targetIdOffset,
          position: event.position.clone(),
          velocity: event.velocity.clone(),
          surfaceNormal: event.surfaceNormal.clone(),
          peakPosition: event.peakPosition.clone(),
        });
      }

      for (const event of demo.targetEvents) {
        merged.targetEvents.push({
          ...event,
          targetId: event.targetId + targetIdOffset,
          position: event.position.clone(),
          velocity: event.velocity.clone(),
          peakPosition: event.peakPosition.clone(),
        });
      }

      projectileIdOffset += demo.header.projectileEvents;
      targetIdOffset += demo.header.targetEvents;
    }

    // Update header
    merged.header.duration = maxDuration;
    merged.header.totalFrames = merged.frames.length;
    merged.header.projectileEvents = merged.projectileEvents.length;
    merged.header.targetEvents = merged.targetEvents.length;
    merged.header.description = `Interleaved merge of ${demos.length} demos`;
    merged.header.timestamp = Date.now();

    return merged;
  }
}
