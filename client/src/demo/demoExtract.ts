import { DEMO_MAGIC, DEMO_FORMAT_VERSION, type DemoFile, type DemoFrame } from './types.js';
import { collectRemoteFrames, collectProjectileEvents, collectTargetEvents } from './demoClip.js';
import type { DemoRecorder } from './DemoRecorder.js';

// DemoFile assembly: whole-recording dump + time-windowed clip
// extraction (timestamps renormalized, frameNumber mod-65536 wrap-safe).

const DEMO_ZERO_FRAME = {
  posX: 0, posY: 0, posZ: 0, yaw: 0, pitch: 0, velX: 0, velY: 0, velZ: 0,
} as unknown as DemoFrame;

export function buildDemoFile(r: DemoRecorder, description = ''): DemoFile {
  const frames = r.frameBuffer.extractAll();
  // Same window semantics as extractClip: a target whose Spawned aged
  // out of the ring still exists in replay, so it gets a synthetic
  // baseline Spawned at the buffer's leading edge instead of becoming
  // an orphaned Destroyed.
  const clipStart = frames.length > 0 ? frames[0]!.timestamp : r.elapsedTime - r.bufferSeconds;
  const targetEvents = collectTargetEvents(r.targetEvents, clipStart, r.elapsedTime);

  return {
    header: {
      magic: DEMO_MAGIC,
      formatVersion: DEMO_FORMAT_VERSION,
      gameVersion: '1.0.0',
      timestamp: Date.now(),
      duration: r.elapsedTime,
      totalFrames: frames.length,
      projectileEventCount: r.projectileEvents.length,
      targetEventCount: targetEvents.length,
      checksum: 0,
      description,
      ...startFrame(frames.length > 0 ? frames[0] : null),
      projectileLifetime: 0,
      ...r.context,
      tableHash: 0, // stamped by the writer at serialize time
    },
    frames,
    projectileEvents: [...r.projectileEvents],
    targetEvents,
    roster: r.roster.map(e => ({ ...e })),
    remoteFrames: [...r.remoteFrames],
    ...(r.heightmap ? { heightmap: r.heightmap } : {}),
  };
}

function startFrame(first: DemoFrame | null) {
  const f = first ?? DEMO_ZERO_FRAME;
  return {
    startPosX: f.posX,
    startPosY: f.posY,
    startPosZ: f.posZ,
    startYaw: f.yaw,
    startPitch: f.pitch,
    startVelX: f.velX,
    startVelY: f.velY,
    startVelZ: f.velZ,
  };
}

export function extractClip(r: DemoRecorder, startTime: number, endTime: number, description: string, projectileLifetime = 0): DemoFile | null {
  if (r.frameBuffer.IsEmpty) {return null;}

  const oldest = r.frameBuffer.peekOldest().timestamp;
  const newest = r.frameBuffer.peekNewest().timestamp;
  const clipStart = Math.max(startTime, oldest);
  const clipEnd = Math.min(endTime, newest);
  if (clipEnd <= clipStart) {return null;}

  const startIdx = r.frameBuffer.findIndexAfterTimestamp(
    clipStart - 0.001, f => f.timestamp
  );
  if (startIdx < 0) {return null;}

  const frames: DemoFrame[] = [];
  for (let i = startIdx; i < r.frameBuffer.Count; i++) {
    const f = r.frameBuffer.getUnsafe(i);
    if (f.timestamp > clipEnd) {break;}
    frames.push(f);
  }
  if (frames.length === 0) {return null;}

  const projEvents = collectProjectileEvents(r.projectileEvents, clipStart, clipEnd);
  const tgtEvents = collectTargetEvents(r.targetEvents, clipStart, clipEnd);

  const first = frames[0];
  const normFrames = frames.map(f => ({ ...f, timestamp: f.timestamp - clipStart,
    frameNumber: (f.frameNumber - first.frameNumber + 65_536) % 65_536,}));
  const normProj = projEvents.map(e => ({ ...e, timestamp: e.timestamp - clipStart}));
  const normTgt = tgtEvents.map(e => ({ ...e, timestamp: e.timestamp - clipStart}));

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
      ...r.context,
      tableHash: 0, // stamped by the writer at serialize time
    },
    frames: normFrames,
    projectileEvents: normProj,
    targetEvents: normTgt,
    roster: r.roster.map(e => ({ ...e })),
    remoteFrames: collectRemoteFrames(r.remoteFrames, clipStart, clipEnd),
    ...(r.heightmap ? { heightmap: r.heightmap } : {}),
  };
}
