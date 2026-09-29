// Demo playback engine - replays recorded frames with interpolation.
// Supports play, pause, seek, speed control, and rewind.

import type { ProjectileEvent, TargetEvent, RemoteFrame, DemoFile } from './types.js';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Angle interpolation (handle wraparound for yaw)
const lerpAngle = (a: number, b: number, t: number) => {
  let diff = b - a;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
};

export interface InterpolatedRemote {
  rosterIdx: number;
  posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number;
  yaw: number; pitch: number;
  flags: number;
}

export interface PlaybackState {
  posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number;
  yaw: number; pitch: number;
  inputFlags: number;
  jetpackFlags: number;
  jetpackFuel: number;
}

export interface PlaybackCallbacks {
  onFrameUpdate?: (state: PlaybackState, events: { projectiles: ProjectileEvent[], targets: TargetEvent[], remotes?: RemoteFrame[] }) => void;
  onPlaybackEnd?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onSeek?: () => void;
}

export class DemoPlayer {
  private demoData: DemoFile | null = null;
  private currentTime = 0;
  private playing = false;
  private playbackSpeed = 1.0;
  private loop = false;
  private frameIndex = 0;
  private callbacks: PlaybackCallbacks = {};

  // Track which events have been emitted
  private lastProjectileEventIndex = 0;
  private lastTargetEventIndex = 0;
  private lastRemoteFrameIndex = 0;

  // Remote frames grouped per roster index at load — the wire interleaves
  // players, but interpolation wants a per-player ordered stream.
  private remotesByIdx: Map<number, RemoteFrame[]> = new Map();

  get isPlaying(): boolean { return this.playing; }
  get isLoaded(): boolean { return this.demoData !== null; }
  get duration(): number { return this.demoData?.header.duration ?? 0; }
  get currentTimeValue(): number { return this.currentTime; }
  get speed(): number { return this.playbackSpeed; }
  get roster(): { name: string }[] { return this.demoData?.roster ?? []; }

  load(data: DemoFile): void {
    this.demoData = data;
    this.currentTime = 0;
    this.frameIndex = 0;
    this.lastProjectileEventIndex = 0;
    this.lastTargetEventIndex = 0;
    this.lastRemoteFrameIndex = 0;
    this.remotesByIdx.clear();
    for (const f of data.remoteFrames) {
      let arr = this.remotesByIdx.get(f.rosterIdx);
      if (!arr) this.remotesByIdx.set(f.rosterIdx, arr = []);
      arr.push(f);
    }
    this.playing = false;
  }

  unload(): void {
    this.demoData = null;
    this.currentTime = 0;
    this.frameIndex = 0;
    this.remotesByIdx.clear();
    this.playing = false;
  }

  setCallbacks(callbacks: PlaybackCallbacks): void {
    this.callbacks = callbacks;
  }

  play(): void {
    if (!this.demoData) return;
    if (this.currentTime >= this.duration) {
      this.currentTime = 0;
      this.frameIndex = 0;
      this.lastProjectileEventIndex = 0;
      this.lastTargetEventIndex = 0;
      this.lastRemoteFrameIndex = 0;
    }
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  stop(): void {
    this.playing = false;
    this.currentTime = 0;
    this.frameIndex = 0;
    this.lastProjectileEventIndex = 0;
    this.lastTargetEventIndex = 0;
    this.lastRemoteFrameIndex = 0;
  }

  seek(time: number): void {
    if (!this.demoData) return;
    // Guard against NaN/Infinity (e.g. from corrupted slider events)
    if (!Number.isFinite(time)) time = 0;
    this.currentTime = Math.max(0, Math.min(time, this.duration));
    this.frameIndex = this.findFrameIndex(this.currentTime);
    // Reset event pointers and re-emit all events from the beginning, so
    // playback reconstructs all in-flight projectiles and balls at the seek
    // time — works even when paused (update() returns early when not playing).
    const { newProjEvents, newTargetEvents, projCount, tgtCount } =
      this.reconstructToTime(this.currentTime);
    const state = this.getInterpolatedState();
    if (this.callbacks.onFrameUpdate) {
      // remotes aren't re-emitted on seek — the handler reads
      // getRemoteStates() and snaps every replica to its pose at `time`
      this.callbacks.onFrameUpdate(state, { projectiles: newProjEvents, targets: newTargetEvents, remotes: [] });
    }
    if (this.callbacks.onTimeUpdate) {
      this.callbacks.onTimeUpdate(this.currentTime, this.duration);
    }
    // Update event indices to current time for continued playback
    this.lastProjectileEventIndex = projCount;
    this.lastTargetEventIndex = tgtCount;
    this.lastRemoteFrameIndex = this.findEventIndex(this.demoData.remoteFrames, this.currentTime);
  }

  setSpeed(speed: number): void {
    // 0 would freeze playback silently forever; NaN poisons currentTime
    if (!Number.isFinite(speed) || speed === 0) return;
    this.playbackSpeed = speed;
  }

  // Forward-only incremental step to `time` — emits just the events in
  // (currentTime, time], unlike seek() which rebuilds the whole world.
  // Offline renderers pump this per output frame; O(new events) not O(all).
  scrubTo(time: number): void {
    if (!this.demoData) return;
    if (!Number.isFinite(time)) time = 0;
    time = Math.max(0, Math.min(time, this.duration));
    if (time < this.currentTime) { this.seek(time); return; }
    this.currentTime = time;
    this.frameIndex = this.findFrameIndex(this.currentTime);
    const state = this.getInterpolatedState();
    const projCount = this.findEventIndex(this.demoData.projectileEvents, this.currentTime);
    const tgtCount = this.findEventIndex(this.demoData.targetEvents, this.currentTime);
    const remoteCount = this.findEventIndex(this.demoData.remoteFrames, this.currentTime);
    const events = {
      projectiles: this.demoData.projectileEvents.slice(this.lastProjectileEventIndex, projCount),
      targets: this.demoData.targetEvents.slice(this.lastTargetEventIndex, tgtCount),
      remotes: this.demoData.remoteFrames.slice(this.lastRemoteFrameIndex, remoteCount),
    };
    this.lastProjectileEventIndex = projCount;
    this.lastTargetEventIndex = tgtCount;
    this.lastRemoteFrameIndex = remoteCount;
    this.callbacks.onFrameUpdate?.(state, events);
    this.callbacks.onTimeUpdate?.(this.currentTime, this.duration);
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  // Called every game frame. dt is real seconds.
  update(dt: number): void {
    if (!this.playing || !this.demoData) return;

    // Guard against NaN/Infinity dt (e.g. from tab visibility quirks)
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    this.currentTime += dt * this.playbackSpeed;

    if (this.currentTime >= this.duration) { this.handleEndOfPlayback(); return; }
    if (this.currentTime < 0) { this.handleRewindWrap(); return; }

    // Find the right frame index for current time
    this.frameIndex = this.findFrameIndex(this.currentTime);

    // Interpolate state between frames
    const state = this.getInterpolatedState();

    // Collect events that occurred since last update.
    // For forward playback this is a simple forward slice.
    // For reverse playback, incremental re-emission is impossible (events are
    // timestamp-ordered and we're moving backward), so we seek-reconstruct.
    let newProjEvents: ProjectileEvent[];
    let newTargetEvents: TargetEvent[];
    let newRemoteFrames: RemoteFrame[];
    if (this.playbackSpeed < 0) {
      // Reverse playback: reconstruct full state at the new time.
      ({ newProjEvents, newTargetEvents } = this.reconstructToTime(this.currentTime));
      newRemoteFrames = [];
    } else {
      newProjEvents = this.collectNewEvents(this.demoData.projectileEvents, this.lastProjectileEventIndex);
      newTargetEvents = this.collectNewEvents(this.demoData.targetEvents, this.lastTargetEventIndex);
      const newRemoteIdx = this.findEventIndex(this.demoData.remoteFrames, this.currentTime);
      newRemoteFrames = this.demoData.remoteFrames.slice(this.lastRemoteFrameIndex, newRemoteIdx);
      this.lastRemoteFrameIndex = newRemoteIdx;
    }

    if (this.callbacks.onFrameUpdate) {
      this.callbacks.onFrameUpdate(state, { projectiles: newProjEvents, targets: newTargetEvents, remotes: newRemoteFrames });
    }

    if (this.callbacks.onTimeUpdate) {
      this.callbacks.onTimeUpdate(this.currentTime, this.duration);
    }

    // Update event indices for next frame
    if (this.demoData) {
      this.lastProjectileEventIndex = this.findEventIndex(this.demoData.projectileEvents, this.currentTime);
      this.lastTargetEventIndex = this.findEventIndex(this.demoData.targetEvents, this.currentTime);
    }
  }

  // Interpolated pose of every rostered remote at the current demo time —
  // used on seek and when the caller needs positions without event deltas.
  getRemoteStates(): InterpolatedRemote[] {
    const out: InterpolatedRemote[] = [];
    for (const [rosterIdx, frames] of this.remotesByIdx) {
      if (frames.length === 0) continue;
      const i = this.findEventIndex(frames, this.currentTime) - 1;
      if (i < 0) continue; // not spawned yet at this time
      const f0 = frames[i]!;
      const f1 = i + 1 < frames.length ? frames[i + 1]! : f0;
      let t = 0;
      const range = f1.timestamp - f0.timestamp;
      if (range > 0) t = Math.max(0, Math.min(1, (this.currentTime - f0.timestamp) / range));
      out.push({
        rosterIdx,
        posX: f0.posX + (f1.posX - f0.posX) * t,
        posY: f0.posY + (f1.posY - f0.posY) * t,
        posZ: f0.posZ + (f1.posZ - f0.posZ) * t,
        velX: f0.velX + (f1.velX - f0.velX) * t,
        velY: f0.velY + (f1.velY - f0.velY) * t,
        velZ: f0.velZ + (f1.velZ - f0.velZ) * t,
        yaw: f0.yaw, pitch: f0.pitch + (f1.pitch - f0.pitch) * t,
        flags: f0.flags,
      });
    }
    return out;
  }

  private handleEndOfPlayback(): void {
    if (this.loop) {
      // Emit any events in the final partial step [prevTime, duration] before
      // wrapping, so a hit/explosion landing exactly at the end isn't lost.
      this.emitFrameAndEvents(this.duration);
      // Wrap to beginning: reset state and seek-reconstruct from t=0
      this.currentTime = 0;
      this.frameIndex = 0;
      this.lastProjectileEventIndex = 0;
      this.lastTargetEventIndex = 0;
      this.lastRemoteFrameIndex = 0;
      this.callbacks.onSeek?.();
      this.emitFrameAndEvents(0);
    } else {
      this.currentTime = this.duration;
      this.playing = false;
      this.callbacks.onPlaybackEnd?.();
      this.callbacks.onTimeUpdate?.(this.currentTime, this.duration);
    }
  }

  private handleRewindWrap(): void {
    if (this.loop) {
      // Emit events for the partial step [0, prevTime] then wrap to end
      this.emitFrameAndEvents(0);
      this.currentTime = this.duration;
      this.frameIndex = this.findFrameIndex(this.currentTime);
      // Reverse playback can't re-emit past events incrementally, so
      // seek-reconstruct the full state at the wrap target.
      this.lastProjectileEventIndex = 0;
      this.lastTargetEventIndex = 0;
      this.lastRemoteFrameIndex = 0;
      this.callbacks.onSeek?.();
      this.emitFrameAndEvents(this.currentTime);
    } else {
      this.currentTime = 0;
      this.playing = false;
      // Same settlement as the forward-end path — without it the manager's
      // mode stays 'playing' against a dead player and Space can't resume.
      this.callbacks.onPlaybackEnd?.();
      this.callbacks.onTimeUpdate?.(this.currentTime, this.duration);
    }
  }

  // Clear all in-flight objects and return every event up to `time`, so the
  // game can rebuild the full state at that timestamp (seek/reverse playback).
  private reconstructToTime(time: number): { newProjEvents: ProjectileEvent[]; newTargetEvents: TargetEvent[]; projCount: number; tgtCount: number } {
    if (!this.demoData) return { newProjEvents: [], newTargetEvents: [], projCount: 0, tgtCount: 0 };
    this.lastProjectileEventIndex = 0;
    this.lastTargetEventIndex = 0;
    this.lastRemoteFrameIndex = 0;
    this.callbacks.onSeek?.();
    const projCount = this.findEventIndex(this.demoData.projectileEvents, time);
    const tgtCount = this.findEventIndex(this.demoData.targetEvents, time);
    return {
      newProjEvents: this.demoData.projectileEvents.slice(0, projCount),
      newTargetEvents: this.demoData.targetEvents.slice(0, tgtCount),
      projCount,
      tgtCount,
    };
  }

  // Emit the interpolated frame state and events up to `time` without advancing
  // currentTime. Used by loop wraparound to flush the final partial step.
  private emitFrameAndEvents(time: number): void {
    if (!this.demoData) return;
    this.frameIndex = this.findFrameIndex(time);
    const state = this.getInterpolatedState();
    const projCount = this.findEventIndex(this.demoData.projectileEvents, time);
    const tgtCount = this.findEventIndex(this.demoData.targetEvents, time);
    const newProjEvents = this.demoData.projectileEvents.slice(this.lastProjectileEventIndex, projCount);
    const newTargetEvents = this.demoData.targetEvents.slice(this.lastTargetEventIndex, tgtCount);
    const remoteCount = this.findEventIndex(this.demoData.remoteFrames, time);
    const newRemoteFrames = this.demoData.remoteFrames.slice(this.lastRemoteFrameIndex, remoteCount);
    if (this.callbacks.onFrameUpdate) {
      this.callbacks.onFrameUpdate(state, { projectiles: newProjEvents, targets: newTargetEvents, remotes: newRemoteFrames });
    }
    if (this.callbacks.onTimeUpdate) {
      this.callbacks.onTimeUpdate(time, this.duration);
    }
    this.lastProjectileEventIndex = projCount;
    this.lastTargetEventIndex = tgtCount;
    this.lastRemoteFrameIndex = remoteCount;
  }

  private findFrameIndex(time: number): number {
    if (!this.demoData || this.demoData.frames.length === 0) return 0;
    const frames = this.demoData.frames;
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

  private findEventIndex(events: { timestamp: number }[], time: number): number {
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

  private collectNewEvents<T extends { timestamp: number }>(events: T[], lastIndex: number): T[] {
    if (!this.demoData) return [];
    if (this.playbackSpeed > 0) {
      const newIndex = this.findEventIndex(events, this.currentTime);
      return events.slice(lastIndex, newIndex);
    }
    return [];
  }

  private getInterpolatedState(): PlaybackState {
    if (!this.demoData || this.demoData.frames.length === 0) {
      return {
        posX: 0, posY: 0, posZ: 0,
        velX: 0, velY: 0, velZ: 0,
        yaw: 0, pitch: 0,
        inputFlags: 0, jetpackFlags: 0, jetpackFuel: 0,
      };
    }

    const frames = this.demoData.frames;
    const i = Math.min(this.frameIndex, frames.length - 1);
    const f0 = frames[i]!;
    const f1 = i + 1 < frames.length ? frames[i + 1]! : f0;

    // Interpolation factor
    let t = 0;
    if (f1 !== f0) {
      const range = f1.timestamp - f0.timestamp;
      if (range > 0) {
        t = (this.currentTime - f0.timestamp) / range;
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
    };
  }

}
