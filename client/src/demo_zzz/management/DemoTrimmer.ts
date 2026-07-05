import { DemoFile } from '../types/DemoFile.js';
import { DemoFrame } from '../types/DemoFrame.js';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { TargetEvent } from '../types/TargetEvent.js';

/**
 * Trim demo files to specific time ranges.
 * Useful for removing unwanted segments from demos.
 */
export class DemoTrimmer {
  /**
   * Trim a demo to a specific time range.
   * @param demo - Demo file to trim
   * @param startTime - Start time in seconds
   * @param endTime - End time in seconds
   * @returns Trimmed demo file
   */
  static trimToTimeRange(demo: DemoFile, startTime: number, endTime: number): DemoFile {
    if (startTime < 0) {
      startTime = 0;
    }

    if (endTime > demo.header.duration) {
      endTime = demo.header.duration;
    }

    if (startTime >= endTime) {
      throw new Error('Start time must be less than end time');
    }

    // Filter frames within time range
    const frames = demo.frames.filter(
      (frame) => frame.timestamp >= startTime && frame.timestamp <= endTime
    );

    // Adjust frame timestamps
    const trimmedFrames = frames.map((frame) => ({
      ...frame,
      timestamp: frame.timestamp - startTime,
      position: frame.position.clone(),
      velocity: frame.velocity.clone(),
      rotation: frame.rotation.clone(),
    }));

    // Filter events within time range
    const projectileEvents = demo.projectileEvents.filter(
      (event) => event.timestamp >= startTime && event.timestamp <= endTime
    );

    const trimmedProjectileEvents = projectileEvents.map((event) => ({
      ...event,
      timestamp: event.timestamp - startTime,
      position: event.position.clone(),
      velocity: event.velocity.clone(),
      surfaceNormal: event.surfaceNormal.clone(),
      peakPosition: event.peakPosition.clone(),
    }));

    const targetEvents = demo.targetEvents.filter(
      (event) => event.timestamp >= startTime && event.timestamp <= endTime
    );

    const trimmedTargetEvents = targetEvents.map((event) => ({
      ...event,
      timestamp: event.timestamp - startTime,
      position: event.position.clone(),
      velocity: event.velocity.clone(),
      peakPosition: event.peakPosition.clone(),
    }));

    // Create trimmed demo
    const trimmed: DemoFile = {
      header: {
        ...demo.header,
        duration: endTime - startTime,
        totalFrames: trimmedFrames.length,
        projectileEvents: trimmedProjectileEvents.length,
        targetEvents: trimmedTargetEvents.length,
        description: `Trimmed: ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s`,
        timestamp: Date.now(),
      },
      frames: trimmedFrames,
      projectileEvents: trimmedProjectileEvents,
      targetEvents: trimmedTargetEvents,
      playerStartPosition: demo.playerStartPosition.clone(),
      playerStartRotation: demo.playerStartRotation.clone(),
      playerStartVelocity: demo.playerStartVelocity.clone(),
    };

    return trimmed;
  }

  /**
   * Trim a demo to a specific frame range.
   * @param demo - Demo file to trim
   * @param startFrame - Start frame index
   * @param endFrame - End frame index
   * @returns Trimmed demo file
   */
  static trimToFrameRange(demo: DemoFile, startFrame: number, endFrame: number): DemoFile {
    if (startFrame < 0) {
      startFrame = 0;
    }

    if (endFrame >= demo.frames.length) {
      endFrame = demo.frames.length - 1;
    }

    if (startFrame >= endFrame) {
      throw new Error('Start frame must be less than end frame');
    }

    const frames = demo.frames.slice(startFrame, endFrame + 1);
    const startTime = frames[0].timestamp;
    const endTime = frames[frames.length - 1].timestamp;

    // Adjust frame timestamps
    const trimmedFrames = frames.map((frame) => ({
      ...frame,
      frameNumber: frame.frameNumber - startFrame,
      timestamp: frame.timestamp - startTime,
      position: frame.position.clone(),
      velocity: frame.velocity.clone(),
      rotation: frame.rotation.clone(),
    }));

    // Filter events within time range
    const projectileEvents = demo.projectileEvents.filter(
      (event) => event.timestamp >= startTime && event.timestamp <= endTime
    );

    const trimmedProjectileEvents = projectileEvents.map((event) => ({
      ...event,
      timestamp: event.timestamp - startTime,
      position: event.position.clone(),
      velocity: event.velocity.clone(),
      surfaceNormal: event.surfaceNormal.clone(),
      peakPosition: event.peakPosition.clone(),
    }));

    const targetEvents = demo.targetEvents.filter(
      (event) => event.timestamp >= startTime && event.timestamp <= endTime
    );

    const trimmedTargetEvents = targetEvents.map((event) => ({
      ...event,
      timestamp: event.timestamp - startTime,
      position: event.position.clone(),
      velocity: event.velocity.clone(),
      peakPosition: event.peakPosition.clone(),
    }));

    // Create trimmed demo
    const trimmed: DemoFile = {
      header: {
        ...demo.header,
        duration: endTime - startTime,
        totalFrames: trimmedFrames.length,
        projectileEvents: trimmedProjectileEvents.length,
        targetEvents: trimmedTargetEvents.length,
        description: `Trimmed: frames ${startFrame} - ${endFrame}`,
        timestamp: Date.now(),
      },
      frames: trimmedFrames,
      projectileEvents: trimmedProjectileEvents,
      targetEvents: trimmedTargetEvents,
      playerStartPosition: demo.playerStartPosition.clone(),
      playerStartRotation: demo.playerStartRotation.clone(),
      playerStartVelocity: demo.playerStartVelocity.clone(),
    };

    return trimmed;
  }

  /**
   * Remove a segment from a demo.
   * @param demo - Demo file to trim
   * @param startTime - Start time of segment to remove
   * @param endTime - End time of segment to remove
   * @returns Trimmed demo file
   */
  static removeSegment(demo: DemoFile, startTime: number, endTime: number): DemoFile {
    if (startTime < 0) {
      startTime = 0;
    }

    if (endTime > demo.header.duration) {
      endTime = demo.header.duration;
    }

    if (startTime >= endTime) {
      throw new Error('Start time must be less than end time');
    }

    // Keep frames outside the segment
    const frames = demo.frames.filter(
      (frame) => frame.timestamp < startTime || frame.timestamp > endTime
    );

    // Adjust timestamps for frames after the removed segment
    const segmentDuration = endTime - startTime;
    const trimmedFrames = frames.map((frame) => ({
      ...frame,
      timestamp: frame.timestamp > endTime ? frame.timestamp - segmentDuration : frame.timestamp,
      position: frame.position.clone(),
      velocity: frame.velocity.clone(),
      rotation: frame.rotation.clone(),
    }));

    // Keep events outside the segment
    const projectileEvents = demo.projectileEvents.filter(
      (event) => event.timestamp < startTime || event.timestamp > endTime
    );

    const trimmedProjectileEvents = projectileEvents.map((event) => ({
      ...event,
      timestamp: event.timestamp > endTime ? event.timestamp - segmentDuration : event.timestamp,
      position: event.position.clone(),
      velocity: event.velocity.clone(),
      surfaceNormal: event.surfaceNormal.clone(),
      peakPosition: event.peakPosition.clone(),
    }));

    const targetEvents = demo.targetEvents.filter(
      (event) => event.timestamp < startTime || event.timestamp > endTime
    );

    const trimmedTargetEvents = targetEvents.map((event) => ({
      ...event,
      timestamp: event.timestamp > endTime ? event.timestamp - segmentDuration : event.timestamp,
      position: event.position.clone(),
      velocity: event.velocity.clone(),
      peakPosition: event.peakPosition.clone(),
    }));

    // Create trimmed demo
    const trimmed: DemoFile = {
      header: {
        ...demo.header,
        duration: demo.header.duration - segmentDuration,
        totalFrames: trimmedFrames.length,
        projectileEvents: trimmedProjectileEvents.length,
        targetEvents: trimmedTargetEvents.length,
        description: `Removed segment: ${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s`,
        timestamp: Date.now(),
      },
      frames: trimmedFrames,
      projectileEvents: trimmedProjectileEvents,
      targetEvents: trimmedTargetEvents,
      playerStartPosition: demo.playerStartPosition.clone(),
      playerStartRotation: demo.playerStartRotation.clone(),
      playerStartVelocity: demo.playerStartVelocity.clone(),
    };

    return trimmed;
  }

  /**
   * Split a demo into multiple segments.
   * @param demo - Demo file to split
   * @param segmentDuration - Duration of each segment in seconds
   * @returns Array of demo segments
   */
  static splitIntoSegments(demo: DemoFile, segmentDuration: number): DemoFile[] {
    const segments: DemoFile[] = [];
    let currentTime = 0;

    while (currentTime < demo.header.duration) {
      const endTime = Math.min(currentTime + segmentDuration, demo.header.duration);
      const segment = DemoTrimmer.trimToTimeRange(demo, currentTime, endTime);
      segments.push(segment);
      currentTime = endTime;
    }

    return segments;
  }
}
