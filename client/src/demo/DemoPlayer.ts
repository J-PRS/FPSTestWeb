// Demo playback engine - replays recorded frames with interpolation.
// Supports play, pause, seek, speed control, and rewind.

import type { DemoFrame, ProjectileEvent, TargetEvent, DemoFile } from './types.js';

export interface PlaybackState {
  posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number;
  yaw: number; pitch: number;
  inputFlags: number;
  jetpackFlags: number;
  jetpackFuel: number;
}

export interface PlaybackCallbacks {
  onFrameUpdate?: (state: PlaybackState, events: { projectiles: ProjectileEvent[], targets: TargetEvent[] }) => void;
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

  get isPlaying(): boolean { return this.playing; }
  get isLoaded(): boolean { return this.demoData !== null; }
  get duration(): number { return this.demoData?.header.duration ?? 0; }
  get currentTimeValue(): number { return this.currentTime; }
  get speed(): number { return this.playbackSpeed; }

  load(data: DemoFile): void {
    this.demoData = data;
    this.currentTime = 0;
    this.frameIndex = 0;
    this.lastProjectileEventIndex = 0;
    this.lastTargetEventIndex = 0;
    this.playing = false;
  }

  unload(): void {
    this.demoData = null;
    this.currentTime = 0;
    this.frameIndex = 0;
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
  }

  seek(time: number): void {
    if (!this.demoData) return;
    this.currentTime = Math.max(0, Math.min(time, this.duration));
    this.frameIndex = this.findFrameIndex(this.currentTime);
    // Reset event pointers to 0 so all events from the beginning get re-emitted.
    // This allows the playback to reconstruct all in-flight projectiles and balls
    // that existed at the seek time.
    this.lastProjectileEventIndex = 0;
    this.lastTargetEventIndex = 0;
    // Notify callback so spawned projectiles can be cleaned up
    this.callbacks.onSeek?.();
    // Emit frame state and all events up to seek time directly, so reconstruction
    // works even when paused (update() returns early when not playing)
    const state = this.getInterpolatedState();
    const projEventCount = this.findEventIndex(this.demoData.projectileEvents, this.currentTime);
    const targetEventCount = this.findEventIndex(this.demoData.targetEvents, this.currentTime);
    const newProjEvents = this.demoData.projectileEvents.slice(0, projEventCount);
    const newTargetEvents = this.demoData.targetEvents.slice(0, targetEventCount);
    if (this.callbacks.onFrameUpdate) {
      this.callbacks.onFrameUpdate(state, { projectiles: newProjEvents, targets: newTargetEvents });
    }
    if (this.callbacks.onTimeUpdate) {
      this.callbacks.onTimeUpdate(this.currentTime, this.duration);
    }
    // Update event indices to current time for continued playback
    this.lastProjectileEventIndex = projEventCount;
    this.lastTargetEventIndex = targetEventCount;
  }

  setSpeed(speed: number): void {
    this.playbackSpeed = speed;
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
  }

  // Called every game frame. dt is real seconds.
  update(dt: number): void {
    if (!this.playing || !this.demoData) return;

    this.currentTime += dt * this.playbackSpeed;

    // Handle end of playback
    if (this.currentTime >= this.duration) {
      if (this.loop) {
        this.currentTime = 0;
        this.frameIndex = 0;
        this.lastProjectileEventIndex = 0;
        this.lastTargetEventIndex = 0;
      } else {
        this.currentTime = this.duration;
        this.playing = false;
        if (this.callbacks.onPlaybackEnd) this.callbacks.onPlaybackEnd();
        if (this.callbacks.onTimeUpdate) this.callbacks.onTimeUpdate(this.currentTime, this.duration);
        return;
      }
    }

    // Handle rewind (negative speed)
    if (this.currentTime < 0) {
      if (this.loop) {
        this.currentTime = this.duration;
      } else {
        this.currentTime = 0;
        this.playing = false;
        return;
      }
    }

    // Find the right frame index for current time
    this.frameIndex = this.findFrameIndex(this.currentTime);

    // Interpolate state between frames
    const state = this.getInterpolatedState();

    // Collect events that occurred since last update
    const newProjEvents = this.collectNewEvents(this.demoData.projectileEvents, this.lastProjectileEventIndex);
    const newTargetEvents = this.collectNewEvents(this.demoData.targetEvents, this.lastTargetEventIndex);

    if (this.callbacks.onFrameUpdate) {
      this.callbacks.onFrameUpdate(state, { projectiles: newProjEvents, targets: newTargetEvents });
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

  private findFrameIndex(time: number): number {
    if (!this.demoData || this.demoData.frames.length === 0) return 0;
    const frames = this.demoData.frames;
    // Binary search for the frame at or before `time`
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].timestamp <= time) {
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
      if (events[mid].timestamp <= time) {
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
    const i = this.frameIndex;
    const f0 = frames[i];
    const f1 = i + 1 < frames.length ? frames[i + 1] : f0;

    // Interpolation factor
    let t = 0;
    if (f1 !== f0) {
      const range = f1.timestamp - f0.timestamp;
      if (range > 0) {
        t = (this.currentTime - f0.timestamp) / range;
        t = Math.max(0, Math.min(1, t));
      }
    }

    // Linear interpolation for position, velocity
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    // Angle interpolation (handle wraparound for yaw)
    const lerpAngle = (a: number, b: number, t: number) => {
      let diff = b - a;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      return a + diff * t;
    };

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
