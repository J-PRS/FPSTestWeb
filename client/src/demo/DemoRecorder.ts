// Demo recording engine - captures frames and events into circular buffers.
// Zero overhead when disabled: all public methods early-out on `!recording`.

import { CircularBuffer } from './CircularBuffer.js';
import {
  DemoFrame, ProjectileEvent, TargetEvent,
  ProjectileEventType, TargetEventType,
  createFrame, DEMO_MAGIC, DEMO_FORMAT_VERSION,
  type DemoFile,
} from './types.js';
import type { IPlayerDataProvider, IInputProvider, Vec3 } from './interfaces.js';

const DEFAULT_BUFFER_SECONDS = 30;
const DEFAULT_TICK_RATE = 60; // frames per second
const MAX_EVENTS_PER_SEC = 1000;

export class DemoRecorder implements IProjectileEventRecorder, ITargetEventRecorder {
  private frameBuffer: CircularBuffer<DemoFrame>;
  private projectileEvents: ProjectileEvent[] = [];
  private targetEvents: TargetEvent[] = [];

  private recording = false;
  private frameNumber = 0;
  private startTime = 0;
  private elapsedTime = 0;
  private lastTickTime = 0;
  private tickInterval: number;
  private bufferSeconds: number;
  private nextProjectileId = 1;

  private playerData: IPlayerDataProvider | null = null;
  private inputData: IInputProvider | null = null;

  // Event rate limiting
  private eventCountThisSecond = 0;
  private lastEventResetTime = 0;

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
    this.frameBuffer.clear();
    this.playerData = playerData;
    this.inputData = inputData;
  }

  stop(): void {
    this.recording = false;
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

    // Prune events older than the frame buffer window — they can never be used in a clip
    const cutoff = this.elapsedTime - this.bufferSeconds;
    while (this.projectileEvents.length > 0 && this.projectileEvents[0].timestamp < cutoff) {
      this.projectileEvents.shift();
    }
    while (this.targetEvents.length > 0 && this.targetEvents[0].timestamp < cutoff) {
      this.targetEvents.shift();
    }
  }

  private checkEventRate(): boolean {
    if (this.elapsedTime - this.lastEventResetTime >= 1.0) {
      this.eventCountThisSecond = 0;
      this.lastEventResetTime = this.elapsedTime;
    }
    if (this.eventCountThisSecond >= MAX_EVENTS_PER_SEC) return false;
    this.eventCountThisSecond++;
    return true;
  }

  // IProjectileEventRecorder
  recordFired(position: Vec3, velocity: Vec3, weaponType: number): number {
    if (!this.recording || !this.checkEventRate()) return 0;
    const id = this.nextProjectileId;
    this.nextProjectileId = (this.nextProjectileId % 65535) + 1;
    this.projectileEvents.push({
      eventType: ProjectileEventType.Fired,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      projectileId: id, weaponType,
      surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
      targetId: 0, hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
    return id;
  }

  recordBounce(projectileId: number, position: Vec3, velocity: Vec3, surfaceNormal: Vec3): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.projectileEvents.push({
      eventType: ProjectileEventType.Bounce,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      projectileId, weaponType: 0,
      surfaceNormalX: surfaceNormal.x, surfaceNormalY: surfaceNormal.y, surfaceNormalZ: surfaceNormal.z,
      targetId: 0, hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  recordHit(projectileId: number, position: Vec3, targetId: number): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.projectileEvents.push({
      eventType: ProjectileEventType.Hit,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: 0, velY: 0, velZ: 0,
      projectileId, weaponType: 0,
      surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
      targetId, hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  recordDestroyed(projectileId: number, position: Vec3): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.projectileEvents.push({
      eventType: ProjectileEventType.Destroyed,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: 0, velY: 0, velZ: 0,
      projectileId, weaponType: 0,
      surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
      targetId: 0, hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  // ITargetEventRecorder
  recordTargetSpawned(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.targetEvents.push({
      eventType: TargetEventType.Spawned,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType, health: 0,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  recordTargetBounce(targetId: number, position: Vec3, velocity: Vec3): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.targetEvents.push({
      eventType: TargetEventType.Bounce,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType: 0, health: 0,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  recordTargetPeak(targetId: number, position: Vec3, velocity: Vec3): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.targetEvents.push({
      eventType: TargetEventType.StateChanged,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType: 0, health: 0,
      hasPeakPosition: true,
      peakPosX: position.x, peakPosY: position.y, peakPosZ: position.z,
    });
  }

  recordTargetHit(targetId: number, position: Vec3, velocity: Vec3, health: number): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.targetEvents.push({
      eventType: TargetEventType.Hit,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType: 0, health,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  recordTargetDestroyed(targetId: number, position: Vec3): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.targetEvents.push({
      eventType: TargetEventType.Destroyed,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: 0, velY: 0, velZ: 0,
      targetId, targetType: 0, health: 0,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  // Extract all recorded data into a DemoFile
  buildDemoFile(description: string = ''): DemoFile {
    const frames = this.frameBuffer.extractAll();
    const first = frames.length > 0 ? frames[0] : null;

    return {
      header: {
        magic: DEMO_MAGIC,
        formatVersion: DEMO_FORMAT_VERSION,
        gameVersion: '1.0.0',
        timestamp: Date.now(),
        duration: this.elapsedTime,
        totalFrames: frames.length,
        projectileEventCount: this.projectileEvents.length,
        targetEventCount: this.targetEvents.length,
        checksum: 0,
        description,
        startPosX: first?.posX ?? 0,
        startPosY: first?.posY ?? 0,
        startPosZ: first?.posZ ?? 0,
        startYaw: first?.yaw ?? 0,
        startPitch: first?.pitch ?? 0,
        startVelX: first?.velX ?? 0,
        startVelY: first?.velY ?? 0,
        startVelZ: first?.velZ ?? 0,
        projectileLifetime: 0,
      },
      frames,
      projectileEvents: this.projectileEvents,
      targetEvents: this.targetEvents,
    };
  }

  // Extract a clip: frames and events within [startTime, endTime].
  // Times are relative to recording start (elapsedTime).
  extractClip(startTime: number, endTime: number, description: string, projectileLifetime: number = 0): DemoFile | null {
    if (this.frameBuffer.IsEmpty) return null;

    // Clamp to available range
    const oldest = this.frameBuffer.peekOldest().timestamp;
    const newest = this.frameBuffer.peekNewest().timestamp;
    const clipStart = Math.max(startTime, oldest);
    const clipEnd = Math.min(endTime, newest);
    if (clipEnd <= clipStart) return null;

    // Find frame indices in the buffer
    const startIdx = this.frameBuffer.findIndexAfterTimestamp(
      clipStart - 0.001, f => f.timestamp
    );
    if (startIdx < 0) return null;

    // Collect frames from startIdx until timestamp > clipEnd
    const frames: DemoFrame[] = [];
    for (let i = startIdx; i < this.frameBuffer.Count; i++) {
      const f = this.frameBuffer.getUnsafe(i);
      if (f.timestamp > clipEnd) break;
      frames.push(f);
    }
    if (frames.length === 0) return null;

    // Collect events in range, plus snapshot events for balls alive before clip start
    const projEvents = this.projectileEvents.filter(
      e => e.timestamp >= clipStart && e.timestamp <= clipEnd
    );

    // Build snapshot of balls alive at clipStart:
    // For each targetId, find the most recent event before clipStart.
    // If it was Spawned/Bounce/StateChanged (not Destroyed), inject a Spawned at clipStart.
    const aliveBalls = new Map<number, TargetEvent>();
    for (const e of this.targetEvents) {
      if (e.timestamp >= clipStart) break;
      if (e.eventType === TargetEventType.Destroyed) {
        aliveBalls.delete(e.targetId);
      } else if (e.eventType === TargetEventType.Spawned) {
        aliveBalls.set(e.targetId, e);
      } else {
        // Bounce or StateChanged — update position/velocity for this ball
        const existing = aliveBalls.get(e.targetId);
        if (existing) {
          aliveBalls.set(e.targetId, {
            ...existing,
            posX: e.posX, posY: e.posY, posZ: e.posZ,
            velX: e.velX, velY: e.velY, velZ: e.velZ,
          });
        }
      }
    }

    // Create synthetic Spawned events at clipStart for alive balls
    const snapshotEvents: TargetEvent[] = [];
    for (const [, e] of aliveBalls) {
      snapshotEvents.push({
        ...e,
        eventType: TargetEventType.Spawned,
        timestamp: clipStart,
      });
    }

    const tgtEvents = [
      ...snapshotEvents,
      ...this.targetEvents.filter(
        e => e.timestamp >= clipStart && e.timestamp <= clipEnd
      ),
    ];

    // Renormalize timestamps to clip start
    const first = frames[0];
    const normFrames = frames.map(f => ({
      ...f,
      timestamp: f.timestamp - clipStart,
      frameNumber: f.frameNumber - first.frameNumber,
    }));
    const normProj = projEvents.map(e => ({ ...e, timestamp: e.timestamp - clipStart }));
    const normTgt = tgtEvents.map(e => ({ ...e, timestamp: e.timestamp - clipStart }));

    return {
      header: {
        magic: DEMO_MAGIC,
        formatVersion: DEMO_FORMAT_VERSION,
        gameVersion: '1.0.0',
        timestamp: Date.now(),
        duration: clipEnd - clipStart,
        totalFrames: normFrames.length,
        projectileEventCount: normProj.length,
        targetEventCount: normTgt.length,
        checksum: 0,
        description,
        startPosX: first.posX, startPosY: first.posY, startPosZ: first.posZ,
        startYaw: first.yaw, startPitch: first.pitch,
        startVelX: first.velX, startVelY: first.velY, startVelZ: first.velZ,
        projectileLifetime,
      },
      frames: normFrames,
      projectileEvents: normProj,
      targetEvents: normTgt,
    };
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
  recordTargetBounce(targetId: number, position: Vec3, velocity: Vec3): void;
  recordTargetPeak(targetId: number, position: Vec3, velocity: Vec3): void;
  recordTargetHit(targetId: number, position: Vec3, velocity: Vec3, health: number): void;
  recordTargetDestroyed(targetId: number, position: Vec3): void;
}

