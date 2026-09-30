// Demo recording engine - captures frames and events into circular buffers.
// Zero overhead when disabled: all public methods early-out on `!recording`.

import { CircularBuffer } from './CircularBuffer.js';
import {
  DemoFrame, ProjectileEvent, TargetEvent, RemoteFrame, RemoteFrameFlags,
  createFrame,
  type DemoFile, type DemoRosterEntry,
} from './types.js';
import type { IPlayerDataProvider, IInputProvider, Vec3 } from './interfaces.js';
import * as ev from './demoEvents.js';
import { buildDemoFile, extractClip } from './demoExtract.js';

const DEFAULT_BUFFER_SECONDS = 30;
const DEFAULT_TICK_RATE = 60; // frames per second
// Remote players don't need the local tick rate — the wire itself only
// carries ~20Hz, so sampling faster just stores duplicates.
const REMOTE_SAMPLE_HZ = 20;

// Splice out all events with timestamp < cutoff in one batch (list is
// append-ordered, so binary search finds the first keeper index).
function pruneEventsBefore(events: { timestamp: number }[], cutoff: number): void {
  if (events.length === 0 || events[0].timestamp >= cutoff) return;
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].timestamp < cutoff) lo = mid + 1;
    else hi = mid;
  }
  events.splice(0, lo);
}

// Minimal shape the recorder needs from a live remote player —
// RemotePlayer and the bots' entries both satisfy it.
export interface RemoteSample {
  id: string;
  posX: number; posY: number; posZ: number;
  velX: number; velY: number; velZ: number;
  yaw: number; pitch: number;
  dead: boolean; ski: boolean;
}

export interface DemoContext {
  room: string; mode: string; playerName: string;
}

export class DemoRecorder implements IProjectileEventRecorder, ITargetEventRecorder {
  frameBuffer: CircularBuffer<DemoFrame>;
  projectileEvents: ProjectileEvent[] = [];
  targetEvents: TargetEvent[] = [];
  remoteFrames: RemoteFrame[] = [];
  rosterIdxById = new Map<string, number>();
  roster: DemoRosterEntry[] = [];
  remoteSource: (() => Iterable<RemoteSample>) | null = null;
  lastRemoteSampleT = 0;
  context: DemoContext = { room: '', mode: '', playerName: '' };

  recording = false;
  frameNumber = 0;
  startTime = 0;
  elapsedTime = 0;
  lastTickTime = 0;
  tickInterval: number;
  bufferSeconds: number;
  nextProjectileId = 1;

  private playerData: IPlayerDataProvider | null = null;
  private inputData: IInputProvider | null = null;

  // Event rate limiting
  eventCountThisSecond = 0;
  lastEventResetTime = 0;

  constructor(bufferSeconds: number = DEFAULT_BUFFER_SECONDS, tickRate: number = DEFAULT_TICK_RATE) {
    this.bufferSeconds = bufferSeconds;
    const capacity = Math.ceil(bufferSeconds * tickRate);
    this.frameBuffer = new CircularBuffer<DemoFrame>(capacity);
    this.tickInterval = 1.0 / tickRate;
  }

  get isRecording(): boolean { return this.recording; }
  get frameCount(): number { return this.frameBuffer.Count; }
  get duration(): number { return this.elapsedTime; }

  start(playerData: IPlayerDataProvider, inputData: IInputProvider): void {
    if (this.recording) return;
    this.recording = true;
    this.frameNumber = 0;
    this.nextProjectileId = 1;
    this.startTime = performance.now() / 1000;
    this.elapsedTime = 0;
    this.lastTickTime = 0;
    this.lastEventResetTime = 0;
    this.eventCountThisSecond = 0;
    this.projectileEvents = [];
    this.targetEvents = [];
    this.remoteFrames = [];
    this.rosterIdxById.clear();
    this.roster = [];
    this.lastRemoteSampleT = 0;
    this.frameBuffer.clear();
    this.playerData = playerData;
    this.inputData = inputData;
  }

  stop(): void {
    this.recording = false;
  }

  // Who/where the clip happened — stamped into every file written from now on
  setContext(ctx: Partial<DemoContext>): void {
    Object.assign(this.context, ctx);
  }

  // Live remote-player source; polled at REMOTE_SAMPLE_HZ while recording
  setRemoteSource(source: (() => Iterable<RemoteSample>) | null): void {
    this.remoteSource = source;
  }

  private sampleRemotes(now: number): void {
    if (!this.remoteSource) return;
    if (now - this.lastRemoteSampleT < 1 / REMOTE_SAMPLE_HZ) return;
    this.lastRemoteSampleT = now;
    for (const s of this.remoteSource()) {
      let idx = this.rosterIdxById.get(s.id);
      if (idx === undefined) {
        idx = this.roster.length;
        this.rosterIdxById.set(s.id, idx);
        this.roster.push({ name: s.id });
      }
      this.remoteFrames.push({
        timestamp: now,
        rosterIdx: idx,
        posX: s.posX, posY: s.posY, posZ: s.posZ,
        velX: s.velX, velY: s.velY, velZ: s.velZ,
        yaw: s.yaw, pitch: s.pitch,
        flags: (s.dead ? RemoteFrameFlags.Dead : 0) | (s.ski ? RemoteFrameFlags.Ski : 0),
      });
    }
  }

  // Called every game frame. Only records at tick interval.
  // dt is seconds since last game frame.
  update(dt: number): void {
    if (!this.recording || !this.playerData || !this.inputData) return;

    this.elapsedTime += dt;
    const now = this.elapsedTime;

    // Only record at tick rate
    if (now - this.lastTickTime < this.tickInterval) return;
    this.lastTickTime = now;

    const p = this.playerData;
    const i = this.inputData;

    const frame = createFrame(this.frameNumber, now);
    frame.posX = p.posX; frame.posY = p.posY; frame.posZ = p.posZ;
    frame.velX = p.velX; frame.velY = p.velY; frame.velZ = p.velZ;
    frame.yaw = p.yaw; frame.pitch = p.pitch;
    frame.inputFlags = i.inputFlags;
    frame.mouseDeltaX = i.mouseDeltaX;
    frame.mouseDeltaY = i.mouseDeltaY;
    frame.jetpackFlags = i.jetpackFlags;
    frame.jetpackFuel = i.jetpackFuel;

    this.frameBuffer.add(frame);
    this.frameNumber = (this.frameNumber + 1) % 65536;

    this.sampleRemotes(now);

    // Prune events older than the frame buffer window — they can never be used in a clip
    const cutoff = this.elapsedTime - this.bufferSeconds;
    pruneEventsBefore(this.projectileEvents, cutoff);
    pruneEventsBefore(this.targetEvents, cutoff);
    pruneEventsBefore(this.remoteFrames, cutoff);
  }

  // Event recorders — the rate-limited projectile/target event spool
  // lives in demoEvents.ts; these keep the interface shape.
  recordFired(position: Vec3, velocity: Vec3, weaponType: number): number {
    return ev.recordFired(this, position, velocity, weaponType);
  }
  recordBounce(projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void {
    ev.recordBounce(this, projectileId, position, velocity, surfaceNormal);
  }
  recordHit(projectileId: number, position: Vec3, targetId: number): void {
    ev.recordHit(this, projectileId, position, targetId);
  }
  recordDestroyed(projectileId: number, position: Vec3): void {
    ev.recordDestroyed(this, projectileId, position);
  }
  recordTargetSpawned(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    ev.recordTargetSpawned(this, targetId, position, velocity, targetType);
  }
  recordTargetBounce(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    ev.recordTargetBounce(this, targetId, position, velocity, targetType);
  }
  recordTargetPeak(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    ev.recordTargetPeak(this, targetId, position, velocity, targetType);
  }
  recordTargetHit(targetId: number, position: Vec3, velocity: Vec3, targetType: number, health: number): void {
    ev.recordTargetHit(this, targetId, position, velocity, targetType, health);
  }
  recordTargetDestroyed(targetId: number, position: Vec3, targetType: number, health: number = 0): void {
    ev.recordTargetDestroyed(this, targetId, position, targetType, health);
  }

  // Extract all recorded data into a DemoFile
  buildDemoFile(description: string = ''): DemoFile { return buildDemoFile(this, description); }

  // Extract a clip: frames and events within [startTime, endTime].
  // Times are relative to recording start (elapsedTime).
  extractClip(startTime: number, endTime: number, description: string, projectileLifetime: number = 0): DemoFile | null {
    return extractClip(this, startTime, endTime, description, projectileLifetime);
  }

}

export interface IProjectileEventRecorder {
  recordFired(position: Vec3, velocity: Vec3, weaponType: number): number;
  recordBounce(projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void;
  recordHit(projectileId: number, position: Vec3, targetId: number): void;
  recordDestroyed(projectileId: number, position: Vec3): void;
}

export interface ITargetEventRecorder {
  recordTargetSpawned(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void;
  recordTargetBounce(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void;
  recordTargetPeak(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void;
  recordTargetHit(targetId: number, position: Vec3, velocity: Vec3, targetType: number, health: number): void;
  recordTargetDestroyed(targetId: number, position: Vec3, targetType: number, health?: number): void;
}

