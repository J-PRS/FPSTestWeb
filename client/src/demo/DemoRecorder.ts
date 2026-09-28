// Demo recording engine - captures frames and events into circular buffers.
// Zero overhead when disabled: all public methods early-out on `!recording`.

import { CircularBuffer } from './CircularBuffer.js';
import {
  DemoFrame, ProjectileEvent, TargetEvent, RemoteFrame, RemoteFrameFlags,
  ProjectileEventType, TargetEventType,
  createFrame, DEMO_MAGIC, DEMO_FORMAT_VERSION,
  type DemoFile, type DemoRosterEntry,
} from './types.js';
import type { IPlayerDataProvider, IInputProvider, Vec3 } from './interfaces.js';

const DEFAULT_BUFFER_SECONDS = 30;
const DEFAULT_TICK_RATE = 60; // frames per second
const MAX_EVENTS_PER_SEC = 1000;
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
  private frameBuffer: CircularBuffer<DemoFrame>;
  private projectileEvents: ProjectileEvent[] = [];
  private targetEvents: TargetEvent[] = [];
  private remoteFrames: RemoteFrame[] = [];
  private rosterIdxById = new Map<string, number>();
  private roster: DemoRosterEntry[] = [];
  private remoteSource: (() => Iterable<RemoteSample>) | null = null;
  private lastRemoteSampleT = 0;
  private context: DemoContext = { room: '', mode: '', playerName: '' };

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
    // 0 = recordFired's rate-limit/not-recording sentinel — no live projectile
    if (projectileId === 0 || !this.recording || !this.checkEventRate()) return;
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
    if (projectileId === 0 || !this.recording || !this.checkEventRate()) return;
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
    if (projectileId === 0 || !this.recording || !this.checkEventRate()) return;
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

  recordTargetBounce(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.targetEvents.push({
      eventType: TargetEventType.Bounce,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType, health: 0,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  recordTargetPeak(targetId: number, position: Vec3, velocity: Vec3, targetType: number): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.targetEvents.push({
      eventType: TargetEventType.StateChanged,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType, health: 0,
      hasPeakPosition: true,
      peakPosX: position.x, peakPosY: position.y, peakPosZ: position.z,
    });
  }

  recordTargetHit(targetId: number, position: Vec3, velocity: Vec3, targetType: number, health: number): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.targetEvents.push({
      eventType: TargetEventType.Hit,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: velocity.x, velY: velocity.y, velZ: velocity.z,
      targetId, targetType, health,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    });
  }

  recordTargetDestroyed(targetId: number, position: Vec3, targetType: number, health: number = 0): void {
    if (!this.recording || !this.checkEventRate()) return;
    this.targetEvents.push({
      eventType: TargetEventType.Destroyed,
      timestamp: this.elapsedTime,
      posX: position.x, posY: position.y, posZ: position.z,
      velX: 0, velY: 0, velZ: 0,
      targetId, targetType, health,
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
        ...this.context,
      },
      frames,
      projectileEvents: [...this.projectileEvents],
      targetEvents: [...this.targetEvents],
      roster: this.roster.map(r => ({ ...r })),
      remoteFrames: [...this.remoteFrames],
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

    const projEvents = this.collectProjectileEvents(clipStart, clipEnd);
    const tgtEvents = this.collectTargetEvents(clipStart, clipEnd);

    // Renormalize timestamps to clip start. frameNumber wraps at 65536, so
    // a clip spanning the wrap would produce negative numbers — mod back.
    const first = frames[0];
    const normFrames = frames.map(f => ({
      ...f,
      timestamp: f.timestamp - clipStart,
      frameNumber: (f.frameNumber - first.frameNumber + 65536) % 65536,
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
        ...this.context,
      },
      frames: normFrames,
      projectileEvents: normProj,
      targetEvents: normTgt,
      roster: this.roster.map(r => ({ ...r })),
      remoteFrames: this.collectRemoteFrames(clipStart, clipEnd),
    };
  }

  // Remote frames inside the clip window, plus one synthetic frame at
  // clipStart per remote whose last sample predates the window — playback
  // shouldn't wait for the next 20Hz sample to place them.
  private collectRemoteFrames(clipStart: number, clipEnd: number): RemoteFrame[] {
    const lastBefore = new Map<number, RemoteFrame>();
    for (const f of this.remoteFrames) {
      if (f.timestamp >= clipStart) break;
      lastBefore.set(f.rosterIdx, f);
    }
    const inWindow = this.remoteFrames.filter(
      f => f.timestamp >= clipStart && f.timestamp <= clipEnd
    );
    const out: RemoteFrame[] = [];
    for (const [, f] of lastBefore) {
      out.push({ ...f, timestamp: clipStart });
    }
    out.push(...inWindow);
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out.map(f => ({ ...f, timestamp: f.timestamp - clipStart }));
  }

  // Projectile events in [clipStart, clipEnd], plus synthetic Fired events at
  // clipStart for projectiles that were in-flight when the clip began.
  private collectProjectileEvents(clipStart: number, clipEnd: number): ProjectileEvent[] {
    // For each projectileId, find the most recent event before clipStart.
    // If it was Fired or Bounce (not Hit/Destroyed), inject a synthetic Fired at clipStart.
    const aliveProjectiles = new Map<number, ProjectileEvent>();
    for (const e of this.projectileEvents) {
      if (e.timestamp >= clipStart) break;
      if (e.eventType === ProjectileEventType.Hit || e.eventType === ProjectileEventType.Destroyed) {
        aliveProjectiles.delete(e.projectileId);
      } else if (e.eventType === ProjectileEventType.Fired) {
        aliveProjectiles.set(e.projectileId, e);
      } else {
        // Bounce — update position/velocity
        const existing = aliveProjectiles.get(e.projectileId);
        if (existing) {
          aliveProjectiles.set(e.projectileId, {
            ...existing,
            posX: e.posX, posY: e.posY, posZ: e.posZ,
            velX: e.velX, velY: e.velY, velZ: e.velZ,
          });
        }
      }
    }

    const snapshotProjEvents: ProjectileEvent[] = [];
    for (const [, e] of aliveProjectiles) {
      snapshotProjEvents.push({
        ...e,
        eventType: ProjectileEventType.Fired,
        timestamp: clipStart,
      });
    }

    return [
      ...snapshotProjEvents,
      ...this.projectileEvents.filter(
        e => e.timestamp >= clipStart && e.timestamp <= clipEnd
      ),
    ];
  }

  // Target events in [clipStart, clipEnd], plus synthetic Spawned events at
  // clipStart for balls that were alive when the clip began (or whose Spawned
  // event was pruned before extractClip ran).
  private collectTargetEvents(clipStart: number, clipEnd: number): TargetEvent[] {
    // For each targetId, find the most recent event before clipStart.
    // If it was Spawned/Bounce/StateChanged/Hit (not Destroyed), inject a Spawned at clipStart.
    // If the Spawned event was pruned, Bounce/StateChanged/Hit events still carry the
    // targetType and position/velocity, so we can create a snapshot from them.
    // For each targetId, find the most recent event before clipStart.
    // If it was Spawned/Bounce/StateChanged/Hit (not Destroyed), inject a Spawned at clipStart.
    const aliveBalls = this.findAliveTargets(clipStart);

    // Create synthetic Spawned events at clipStart for alive balls
    const snapshotEvents: TargetEvent[] = [];
    for (const [, e] of aliveBalls) {
      snapshotEvents.push({
        ...e,
        eventType: TargetEventType.Spawned,
        timestamp: clipStart,
      });
    }

    // Target events that fall inside the clip window
    const actualTgtEvents = this.targetEvents.filter(
      e => e.timestamp >= clipStart && e.timestamp <= clipEnd
    );

    return [
      ...snapshotEvents,
      ...this.recoverMissingSpawns(actualTgtEvents, aliveBalls, clipStart),
      ...actualTgtEvents,
    ];
  }

  // Replay target events before clipStart to find which balls were alive then.
  // If the Spawned event was pruned, Bounce/StateChanged/Hit events still carry
  // the targetType and position/velocity, so we can create a snapshot from them.
  private findAliveTargets(clipStart: number): Map<number, TargetEvent> {
    const aliveBalls = new Map<number, TargetEvent>();
    for (const e of this.targetEvents) {
      if (e.timestamp >= clipStart) break;
      if (e.eventType === TargetEventType.Destroyed) {
        aliveBalls.delete(e.targetId);
        continue;
      }
      // Spawned/Bounce/StateChanged/Hit — update or create alive entry
      const existing = aliveBalls.get(e.targetId);
      if (!existing) {
        aliveBalls.set(e.targetId, e);
        continue;
      }
      // Preserve targetType and health if the new event doesn't carry them (legacy 0)
      const targetType = e.targetType !== 0 ? e.targetType : existing.targetType;
      const health = e.health !== 0 ? e.health : existing.health;
      aliveBalls.set(e.targetId, { ...e, targetType, health });
    }
    return aliveBalls;
  }

  // For any targetId that appears inside the clip but has no Spawned event and
  // no alive snapshot, create a synthetic Spawned at clipStart from its first
  // event. This covers Spawned events that were pruned before extractClip ran.
  private recoverMissingSpawns(actualTgtEvents: TargetEvent[], aliveBalls: Map<number, TargetEvent>, clipStart: number): TargetEvent[] {
    const firstEventByTargetId = new Map<number, TargetEvent>();
    const hasSpawnedInClip = new Set<number>();
    for (const e of actualTgtEvents) {
      if (!firstEventByTargetId.has(e.targetId)) {
        firstEventByTargetId.set(e.targetId, e);
      }
      if (e.eventType === TargetEventType.Spawned) {
        hasSpawnedInClip.add(e.targetId);
      }
    }
    const additionalSpawned: TargetEvent[] = [];
    for (const [targetId, first] of firstEventByTargetId) {
      if (aliveBalls.has(targetId) || hasSpawnedInClip.has(targetId)) continue;
      additionalSpawned.push({
        ...first,
        eventType: TargetEventType.Spawned,
        timestamp: clipStart,
      });
    }
    return additionalSpawned;
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

