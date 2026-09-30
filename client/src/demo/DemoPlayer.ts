// Demo playback engine - replays recorded frames with interpolation.
// Supports play, pause, seek, speed control, and rewind.

import type { ProjectileEvent, TargetEvent, RemoteFrame, DemoFile } from './types.js';
import * as pb from './demoPlayback.js';

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
  demoData: DemoFile | null = null;
  currentTime = 0;
  playing = false;
  playbackSpeed = 1.0;
  loop = false;
  frameIndex = 0;
  callbacks: PlaybackCallbacks = {};

  // Track which events have been emitted
  lastProjectileEventIndex = 0;
  lastTargetEventIndex = 0;
  lastRemoteFrameIndex = 0;

  // Remote frames grouped per roster index at load — the wire interleaves
  // players, but interpolation wants a per-player ordered stream.
  remotesByIdx: Map<number, RemoteFrame[]> = new Map();

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
    this.frameIndex = pb.findFrameIndex(this, this.currentTime);
    // Reset event pointers and re-emit all events from the beginning, so
    // playback reconstructs all in-flight projectiles and balls at the seek
    // time — works even when paused (update() returns early when not playing).
    const { newProjEvents, newTargetEvents, projCount, tgtCount } =
      pb.reconstructToTime(this, this.currentTime);
    const state = pb.getInterpolatedState(this);
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
    this.lastRemoteFrameIndex = pb.findEventIndex(this.demoData.remoteFrames, this.currentTime);
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
    this.frameIndex = pb.findFrameIndex(this, this.currentTime);
    const state = pb.getInterpolatedState(this);
    const projCount = pb.findEventIndex(this.demoData.projectileEvents, this.currentTime);
    const tgtCount = pb.findEventIndex(this.demoData.targetEvents, this.currentTime);
    const remoteCount = pb.findEventIndex(this.demoData.remoteFrames, this.currentTime);
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

    if (this.currentTime >= this.duration) { pb.handleEndOfPlayback(this); return; }
    if (this.currentTime < 0) { pb.handleRewindWrap(this); return; }

    // Find the right frame index for current time
    this.frameIndex = pb.findFrameIndex(this, this.currentTime);

    // Interpolate state between frames
    const state = pb.getInterpolatedState(this);

    // Collect events that occurred since last update.
    // For forward playback this is a simple forward slice.
    // For reverse playback, incremental re-emission is impossible (events are
    // timestamp-ordered and we're moving backward), so we seek-reconstruct.
    let newProjEvents: ProjectileEvent[];
    let newTargetEvents: TargetEvent[];
    let newRemoteFrames: RemoteFrame[];
    if (this.playbackSpeed < 0) {
      // Reverse playback: reconstruct full state at the new time.
      ({ newProjEvents, newTargetEvents } = pb.reconstructToTime(this, this.currentTime));
      newRemoteFrames = [];
    } else {
      newProjEvents = pb.collectNewEvents(this, this.demoData.projectileEvents, this.lastProjectileEventIndex);
      newTargetEvents = pb.collectNewEvents(this, this.demoData.targetEvents, this.lastTargetEventIndex);
      const newRemoteIdx = pb.findEventIndex(this.demoData.remoteFrames, this.currentTime);
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
      this.lastProjectileEventIndex = pb.findEventIndex(this.demoData.projectileEvents, this.currentTime);
      this.lastTargetEventIndex = pb.findEventIndex(this.demoData.targetEvents, this.currentTime);
    }
  }

  // Interpolated pose of every rostered remote at the current demo time —
  // used on seek and when the caller needs positions without event deltas.
  getRemoteStates(): InterpolatedRemote[] {
    const out: InterpolatedRemote[] = [];
    for (const [rosterIdx, frames] of this.remotesByIdx) {
      if (frames.length === 0) continue;
      const i = pb.findEventIndex(frames, this.currentTime) - 1;
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

}
  // Playback internals moved to demoPlayback.ts — delegates keep the
  // flat surface the rest of the class calls.
