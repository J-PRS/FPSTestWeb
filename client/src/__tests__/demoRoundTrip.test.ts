// Demo writer→reader round-trip: the format is our fossil record — a
// silent field-layout break makes every clip unreadable. float32 fields
// compare by closeness (they're quantized on write by design).
import { describe, it, expect } from 'vitest';
import { serializeDemo } from '../demo/demoWriter.js';
import { deserializeDemo } from '../demo/demoReader.js';
import {
  createHeader, createFrame, DEMO_FORMAT_VERSION,
  ProjectileEventType, TargetEventType,
  type DemoFile, type ProjectileEvent, type TargetEvent, type RemoteFrame,
} from '../demo/types.js';

function mkFile(): DemoFile {
  const header = createHeader();
  header.description = 'epic disc shot';
  header.duration = 8.5;
  header.room = 'quicksand';
  header.mode = 'ctf';
  header.playerName = 'jp';
  header.startPosX = 10; header.startPosY = 50; header.startPosZ = -20;
  header.startYaw = 1.2; header.startPitch = -0.3;
  header.projectileLifetime = 4.2;

  const frames = [0, 1, 2].map((i) => {
    const f = createFrame(i, i * 0.05);
    f.posX = i * 3.25; f.posY = 40 + i; f.posZ = -i * 1.5;
    f.velX = 30; f.velY = 8; f.velZ = -12;
    f.yaw = 0.5 + i * 0.01; f.pitch = -0.2;
    f.inputFlags = 0b1011; f.mouseDeltaX = 12; f.mouseDeltaY = -7;
    f.jetpackFlags = 1; f.jetpackFuel = 0.65; f.weaponType = 7;
    return f;
  });

  const projectileEvents: ProjectileEvent[] = [{
    eventType: ProjectileEventType.Fired, timestamp: 0.05,
    posX: 1, posY: 2, posZ: 3, velX: 40, velY: 5, velZ: -6,
    projectileId: 42, weaponType: 3,
    surfaceNormalX: 0, surfaceNormalY: 1, surfaceNormalZ: 0,
    targetId: 9, targetType: 1, hasPeakPosition: true,
    peakPosX: 8, peakPosY: 9, peakPosZ: 10,
  }];

  const targetEvents: TargetEvent[] = [{
    eventType: TargetEventType.Spawned, timestamp: 0.02,
    posX: 5, posY: 6, posZ: 7, velX: 1, velY: 2, velZ: 3,
    targetId: 77, targetType: 2, health: 150,
    hasPeakPosition: false, peakPosX: 0, peakPosY: 0, peakPosZ: 0,
  }];

  const remoteFrames: RemoteFrame[] = [{
    timestamp: 0.05, rosterIdx: 0,
    posX: -5, posY: 30, posZ: 15, velX: 10, velY: 0, velZ: -3,
    yaw: 2.1, pitch: 0.4, flags: 0b11,
  }];

  // Counts are caller-populated (the writer trusts the header).
  header.totalFrames = frames.length;
  header.projectileEventCount = projectileEvents.length;
  header.targetEventCount = targetEvents.length;

  return {
    header, frames, projectileEvents, targetEvents,
    roster: [{ name: 'alpha_bot' }, { name: 'bravo_bot' }],
    remoteFrames,
  };
}

describe('demo round-trip', (): void => {
  it('writer→reader preserves all recorded fields', (): void => {
    const src = mkFile();
    const out = deserializeDemo(serializeDemo(src));

    expect(out.header.formatVersion).toBe(DEMO_FORMAT_VERSION);
    expect(out.header.description).toBe(src.header.description);
    expect(out.header.room).toBe('quicksand');
    expect(out.header.mode).toBe('ctf');
    expect(out.header.playerName).toBe('jp');
    expect(out.header.projectileLifetime).toBeCloseTo(4.2, 4);

    expect(out.frames).toHaveLength(3);
    const f = out.frames[1]!;
    expect(f.frameNumber).toBe(1);
    expect(f.posX).toBeCloseTo(3.25, 3);
    expect(f.velZ).toBeCloseTo(-12, 3);
    expect(f.yaw).toBeCloseTo(0.51, 3);
    expect(f.inputFlags).toBe(0b1011);
    expect(f.mouseDeltaX).toBe(12);
    expect(f.mouseDeltaY).toBe(-7);
    expect(f.jetpackFlags).toBe(1);
    expect(f.jetpackFuel).toBeCloseTo(0.65, 3);
    // v4: the whole point of the bump — weapon survives the trip.
    expect(f.weaponType).toBe(7);

    const pe = out.projectileEvents[0]!;
    expect(pe.eventType).toBe(ProjectileEventType.Fired);
    expect(pe.projectileId).toBe(42);
    expect(pe.weaponType).toBe(3);
    expect(pe.targetId).toBe(9);
    expect(pe.hasPeakPosition).toBe(true);
    expect(pe.peakPosZ).toBeCloseTo(10, 3);

    const te = out.targetEvents[0]!;
    expect(te.targetId).toBe(77);
    expect(te.health).toBeCloseTo(150, 3);
    expect(te.hasPeakPosition).toBe(false);

    expect(out.roster.map((r): string => r.name)).toEqual(['alpha_bot', 'bravo_bot']);
    const rf = out.remoteFrames[0]!;
    expect(rf.rosterIdx).toBe(0);
    expect(rf.posZ).toBeCloseTo(15, 3);
    expect(rf.flags).toBe(0b11);
  });

  it('reader rejects a corrupted payload', (): void => {
    const buf = serializeDemo(mkFile());
    const bytes = new Uint8Array(buf);
    bytes[bytes.length - 10]! ^= 0xFF;
    expect((): DemoFile => deserializeDemo(buf)).toThrow(/demo/i);
  });
});
