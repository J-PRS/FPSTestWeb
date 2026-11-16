// Demo playback engine - replays recorded frames with interpolation.
// Supports play, pause, seek, speed control, and rewind.

import { RemoteFrameFlags, type ProjectileEvent, type TargetEvent, type RemoteFrame, type DemoFile } from './types.js';
import * as pb from './demoPlayback.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('DemoPlayer');

export interface InterpolatedRemote {
  rosterIdx: number;
  posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number;
  yaw: number; pitch: number;
  flags: number;
  // v8 meta — stepped (not lerped) like flags: hp/team/held jump, never blend.
  team?: number; hp?: number; held?: number; sheep?: number;
  cls?: number; status?: number; wid?: number;
}

export interface PlaybackState {
  posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number;
  yaw: number; pitch: number;
  inputFlags: number;
  jetpackFlags: number;
  jetpackFuel: number;
  weaponType: number;
  health: number;
  armor: number;
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
  playbackSpeed = 1;
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
    this.sanitize(data);
    for (const f of data.remoteFrames) {
      let arr = this.remotesByIdx.get(f.rosterIdx);
      if (!arr) {this.remotesByIdx.set(f.rosterIdx, arr = []);}
      arr.push(f);
    }
    this.playing = false;
  }

  /** Malformed-lane hygiene - every downstream lookup is a binary search
   *  or a roster-table read, so garbage in = silent ghosts, not errors.
   *  Sort unsorted lanes (files are timestamp-ordered by contract), drop
   *  non-finite rows and remoteFrames pointing outside the roster, and
   *  disambiguate same-name roster rows (a reseat splits one human into
   *  two idx entries with identical names). */
  private sanitize(data: DemoFile): void {
    const bad = { unsorted: 0, nan: 0, roster: 0 };
    const lane = <T extends { timestamp: number }>(events: T[]): T[] => {
      let sorted = events;
      for (let i = 1; i < events.length; i += 1) {
        if (events[i]!.timestamp < events[i - 1]!.timestamp) {
          bad.unsorted += 1;
          sorted = events.toSorted((a, b): number => a.timestamp - b.timestamp);
          break;
        }
      }
      return sorted;
    };
    data.frames = lane(data.frames);
    data.projectileEvents = lane(data.projectileEvents);
    data.targetEvents = lane(data.targetEvents);
    data.remoteFrames = lane(data.remoteFrames);
    const rosterN = data.roster.length;
    data.remoteFrames = data.remoteFrames.filter((f): boolean => {
      const ok = Number.isFinite(f.posX + f.posY + f.posZ) && f.rosterIdx >= 0 && f.rosterIdx < rosterN;
      if (!ok) {bad[f.rosterIdx >= 0 && f.rosterIdx < rosterN ? 'nan' : 'roster'] += 1;}
      return ok;
    });
    data.frames = data.frames.filter((f): boolean => {
      const ok = Number.isFinite(f.posX + f.posY + f.posZ);
      if (!ok) {bad.nan += 1;}
      return ok;
    });
    const seen = new Map<string, number>();
    for (const r of data.roster) {
      const n = (seen.get(r.name) ?? 0) + 1;
      seen.set(r.name, n);
      if (n > 1) {r.name = `${r.name} (${n})`;}
    }
    // Duration guard: a header claiming 0s ends playback on the first
    // update; fall back to the last timestamp any lane recorded.
    if (!(data.header.duration > 0)) {
      const last = Math.max(
        data.frames.at(-1)?.timestamp ?? 0,
        data.remoteFrames.at(-1)?.timestamp ?? 0,
        data.targetEvents.at(-1)?.timestamp ?? 0,
        data.projectileEvents.at(-1)?.timestamp ?? 0,
      );
      if (last > 0) {data.header.duration = last;}
    }
    if (bad.unsorted + bad.nan + bad.roster > 0) {
      logger.warn('sanitized malformed file', bad);
    }
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
    if (!this.demoData) {return;}
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
    if (!this.demoData) {return;}
    // Guard against NaN/Infinity (e.g. from corrupted slider events)
    const t = Number.isFinite(time) ? time : 0;
    this.currentTime = Math.max(0, Math.min(t, this.duration));
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
    if (!Number.isFinite(speed) || speed === 0) {return;}
    this.playbackSpeed = speed;
  }

  // Forward-only incremental step to `time` — emits just the events in
  // (currentTime, time], unlike seek() which rebuilds the whole world.
  // Offline renderers pump this per output frame; O(new events) not O(all).
  scrubTo(time: number): void {
    if (!this.demoData) {return;}
    if (!Number.isFinite(time)) {this.seek(0); return;}
    const t = Math.max(0, Math.min(time, this.duration));
    if (t < this.currentTime) { this.seek(t); return; }
    this.currentTime = t;
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
    if (!this.playing || !this.demoData) {return;}

    // Guard against NaN/Infinity dt (e.g. from tab visibility quirks)
    const step = (Number.isFinite(dt) && dt >= 0) ? dt : 0;
    this.currentTime += step * this.playbackSpeed;

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
    // oxlint-disable-next-line init-declarations -- assigned later
    let newProjEvents!: ProjectileEvent[];
    // oxlint-disable-next-line init-declarations -- assigned later
    let newTargetEvents!: TargetEvent[];
    // oxlint-disable-next-line init-declarations -- assigned later
    let newRemoteFrames!: RemoteFrame[];
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
      if (frames.length === 0) {continue;}
      const i = pb.findEventIndex(frames, this.currentTime) - 1;
      if (i < 0) {continue;} // not spawned yet at this time
      const f0 = frames[i]!;
      const f1 = i + 1 < frames.length ? frames[i + 1]! : f0;
      let t = 0;
      const range = f1.timestamp - f0.timestamp;
      if (range > 0) {t = Math.max(0, Math.min(1, (this.currentTime - f0.timestamp) / range));}
      // Teleport marks a reseat jump the recorded vel can't bridge -
      // blending it sweeps the body across the map; snap to the edge.
      // Pre-flag files (v7 streams) carry no marker: fall back to a
      // distance tripwire - a body can't cover 40m inside one 20Hz gap.
      const teleport = (f1.flags & RemoteFrameFlags.Teleport) !== 0
        || Math.hypot(f1.posX - f0.posX, f1.posY - f0.posY, f1.posZ - f0.posZ) > 40;
      if (f1 !== f0 && teleport) {t = 1;}
      // Dead bodies don't lerp - hold the last live pose until the flag
      // clears (respawn edge carries Teleport anyway).
      if (f0.flags & RemoteFrameFlags.Dead) {t = 0;}
      out.push({
        rosterIdx,
        posX: f0.posX + (f1.posX - f0.posX) * t,
        posY: f0.posY + (f1.posY - f0.posY) * t,
        posZ: f0.posZ + (f1.posZ - f0.posZ) * t,
        velX: f0.velX + (f1.velX - f0.velX) * t,
        velY: f0.velY + (f1.velY - f0.velY) * t,
        velZ: f0.velZ + (f1.velZ - f0.velZ) * t,
        yaw: pb.lerpAngle(f0.yaw, f1.yaw, t),
        pitch: f0.pitch + (f1.pitch - f0.pitch) * t,
        flags: f0.flags,
        team: f0.team, hp: f0.hp, held: f0.held, sheep: f0.sheep,
        cls: f0.cls, status: f0.status, wid: f0.wid,
      });
    }
    return out;
  }

}
  // Playback internals moved to demoPlayback.ts — delegates keep the
  // flat surface the rest of the class calls.
