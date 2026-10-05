import type { ProjectileEvent, TargetEvent } from './types.js';
import { lerpAngle } from '../../../shared/angles.ts';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export { lerpAngle };
import type { DemoPlayer, PlaybackState } from './DemoPlayer.js';

// Playback internals — loop-wrap handling, seek reconstruction, event
// window collection and frame interpolation. DemoPlayer is the host;
// these take it flat (same pattern as the other *Host splits).

export function handleEndOfPlayback(p: DemoPlayer): void {
    if (p.loop) {
      // Emit any events in the final partial step [prevTime, duration] before
      // wrapping, so a hit/explosion landing exactly at the end isn't lost.
      emitFrameAndEvents(p, p.duration);
      // Wrap to beginning: reset state and seek-reconstruct from t=0
      p.currentTime = 0;
      p.frameIndex = 0;
      p.lastProjectileEventIndex = 0;
      p.lastTargetEventIndex = 0;
      p.lastRemoteFrameIndex = 0;
      p.callbacks.onSeek?.();
      emitFrameAndEvents(p, 0);
    } else {
      p.currentTime = p.duration;
      p.playing = false;
      p.callbacks.onPlaybackEnd?.();
      p.callbacks.onTimeUpdate?.(p.currentTime, p.duration);
    }
  }

export function handleRewindWrap(p: DemoPlayer): void {
    if (p.loop) {
      // Emit events for the partial step [0, prevTime] then wrap to end
      emitFrameAndEvents(p, 0);
      p.currentTime = p.duration;
      p.frameIndex = findFrameIndex(p, p.currentTime);
      // Reverse playback can't re-emit past events incrementally, so
      // seek-reconstruct the full state at the wrap target.
      p.lastProjectileEventIndex = 0;
      p.lastTargetEventIndex = 0;
      p.lastRemoteFrameIndex = 0;
      p.callbacks.onSeek?.();
      emitFrameAndEvents(p, p.currentTime);
    } else {
      p.currentTime = 0;
      p.playing = false;
      // Same settlement as the forward-end path — without it the manager's
      // mode stays 'playing' against a dead player and Space can't resume.
      p.callbacks.onPlaybackEnd?.();
      p.callbacks.onTimeUpdate?.(p.currentTime, p.duration);
    }
  }

  // Clear all in-flight objects and return every event up to `time`, so the
  // game can rebuild the full state at that timestamp (seek/reverse playback).
export function reconstructToTime(p: DemoPlayer, time: number): { newProjEvents: ProjectileEvent[]; newTargetEvents: TargetEvent[]; projCount: number; tgtCount: number } {
    if (!p.demoData) {return { newProjEvents: [], newTargetEvents: [], projCount: 0, tgtCount: 0 };}
    p.lastProjectileEventIndex = 0;
    p.lastTargetEventIndex = 0;
    p.lastRemoteFrameIndex = 0;
    p.callbacks.onSeek?.();
    const projCount = findEventIndex(p.demoData.projectileEvents, time);
    const tgtCount = findEventIndex(p.demoData.targetEvents, time);
    return {
      newProjEvents: p.demoData.projectileEvents.slice(0, projCount),
      newTargetEvents: p.demoData.targetEvents.slice(0, tgtCount),
      projCount,
      tgtCount,
    };
  }

  // Emit the interpolated frame state and events up to `time` without advancing
  // currentTime. Used by loop wraparound to flush the final partial step.
export function emitFrameAndEvents(p: DemoPlayer, time: number): void {
    if (!p.demoData) {return;}
    p.frameIndex = findFrameIndex(p, time);
    const state = getInterpolatedState(p,);
    const projCount = findEventIndex(p.demoData.projectileEvents, time);
    const tgtCount = findEventIndex(p.demoData.targetEvents, time);
    const newProjEvents = p.demoData.projectileEvents.slice(p.lastProjectileEventIndex, projCount);
    const newTargetEvents = p.demoData.targetEvents.slice(p.lastTargetEventIndex, tgtCount);
    const remoteCount = findEventIndex(p.demoData.remoteFrames, time);
    const newRemoteFrames = p.demoData.remoteFrames.slice(p.lastRemoteFrameIndex, remoteCount);
    if (p.callbacks.onFrameUpdate) {
      p.callbacks.onFrameUpdate(state, { projectiles: newProjEvents, targets: newTargetEvents, remotes: newRemoteFrames });
    }
    if (p.callbacks.onTimeUpdate) {
      p.callbacks.onTimeUpdate(time, p.duration);
    }
    p.lastProjectileEventIndex = projCount;
    p.lastTargetEventIndex = tgtCount;
    p.lastRemoteFrameIndex = remoteCount;
  }

export function findFrameIndex(p: DemoPlayer, time: number): number {
    if (!p.demoData || p.demoData.frames.length === 0) {return 0;}
    const frames = p.demoData.frames;
    // Binary search for the frame at or before `time`
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid]!.timestamp <= time) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

export function findEventIndex(events: { timestamp: number }[], time: number): number {
    // Find the first event index with timestamp > time
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.timestamp <= time) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

export function collectNewEvents<T extends { timestamp: number }>(p: DemoPlayer, events: T[], lastIndex: number): T[] {
    if (!p.demoData) {return [];}
    if (p.playbackSpeed > 0) {
      const newIndex = findEventIndex(events, p.currentTime);
      return events.slice(lastIndex, newIndex);
    }
    return [];
  }

export function getInterpolatedState(p: DemoPlayer): PlaybackState {
    if (!p.demoData || p.demoData.frames.length === 0) {
      return {
        posX: 0, posY: 0, posZ: 0,
        velX: 0, velY: 0, velZ: 0,
        yaw: 0, pitch: 0,
        inputFlags: 0, jetpackFlags: 0, jetpackFuel: 0, weaponType: 0,
      };
    }

    const frames = p.demoData.frames;
    const i = Math.min(p.frameIndex, frames.length - 1);
    const f0 = frames[i]!;
    const f1 = i + 1 < frames.length ? frames[i + 1]! : f0;

    // Interpolation factor
    let t = 0;
    if (f1 !== f0) {
      const range = f1.timestamp - f0.timestamp;
      if (range > 0) {
        t = (p.currentTime - f0.timestamp) / range;
        t = Math.max(0, Math.min(1, t));
      }
    }

    return {
      posX: lerp(f0.posX, f1.posX, t),
      posY: lerp(f0.posY, f1.posY, t),
      posZ: lerp(f0.posZ, f1.posZ, t),
      velX: lerp(f0.velX, f1.velX, t),
      velY: lerp(f0.velY, f1.velY, t),
      velZ: lerp(f0.velZ, f1.velZ, t),
      yaw: lerpAngle(f0.yaw, f1.yaw, t),
      pitch: lerp(f0.pitch, f1.pitch, t),
      inputFlags: t < 0.5 ? f0.inputFlags : f1.inputFlags,
      jetpackFlags: t < 0.5 ? f0.jetpackFlags : f1.jetpackFlags,
      jetpackFuel: lerp(f0.jetpackFuel, f1.jetpackFuel, t),
      // Held weapon is discrete like the flags — snap at midpoint, not lerp.
      weaponType: t < 0.5 ? f0.weaponType : f1.weaponType,
    };
  }

