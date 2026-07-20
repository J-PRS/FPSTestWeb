import { describe, it, expect } from 'bun:test';
import { DemoSerializer } from '../../client/src/demo/DemoSerializer.ts';
import {
  DEMO_MAGIC, DEMO_FORMAT_VERSION,
  ProjectileEventType, TargetEventType,
  createFrame, createHeader,
  type DemoFile,
} from '../../client/src/demo/types.ts';

function makeDemoFile(): DemoFile {
  const frames = [
    createFrame(0, 0.0),
    createFrame(1, 0.016),
    createFrame(2, 0.033),
  ];
  frames[0].posX = 10.5; frames[0].posY = 20.0; frames[0].posZ = -5.3;
  frames[0].velX = 1.0; frames[0].velY = 0.0; frames[0].velZ = 3.5;
  frames[0].yaw = 1.57; frames[0].pitch = -0.3;
  frames[0].inputFlags = 0b10101;
  frames[0].mouseDeltaX = -100;
  frames[0].mouseDeltaY = 50;
  frames[0].jetpackFlags = 1;
  frames[0].jetpackFuel = 42.5;

  frames[1].posX = 11.0; frames[1].posY = 20.1; frames[1].posZ = -5.0;

  const header = createHeader();
  header.duration = 10.5;
  header.totalFrames = 3;
  header.projectileEventCount = 2;
  header.targetEventCount = 1;
  header.description = 'Test demo clip';
  header.startPosX = 10.5;
  header.startPosY = 20.0;
  header.startPosZ = -5.3;
  header.projectileLifetime = 3.5;

  const projectileEvents = [
    {
      eventType: ProjectileEventType.Fired,
      timestamp: 1.0,
      posX: 10, posY: 20, posZ: -5,
      velX: 0, velY: 50, velZ: 0,
      projectileId: 1,
      weaponType: 2,
      surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 0,
      targetId: 0,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    },
    {
      eventType: ProjectileEventType.Hit,
      timestamp: 4.5,
      posX: 15, posY: 80, posZ: -5,
      velX: 0, velY: 0, velZ: 0,
      projectileId: 1,
      weaponType: 0,
      surfaceNormalX: 0, surfaceNormalY: 1, surfaceNormalZ: 0,
      targetId: 42,
      hasPeakPosition: true,
      peakPosX: 15, peakPosY: 90, peakPosZ: -5,
    },
  ];

  const targetEvents = [
    {
      eventType: TargetEventType.Spawned,
      timestamp: 0.5,
      posX: 100, posY: 50, posZ: 200,
      velX: 1, velY: -2, velZ: 0.5,
      targetId: 42,
      targetType: 3,
      health: 100,
      hasPeakPosition: false,
      peakPosX: 0, peakPosY: 0, peakPosZ: 0,
    },
  ];

  return { header, frames, projectileEvents, targetEvents };
}

describe('DemoSerializer round-trip', () => {
  it('serializes and deserializes without data loss', () => {
    const original = makeDemoFile();
    const buffer = DemoSerializer.serialize(original);
    const restored = DemoSerializer.deserialize(buffer);

    // Header
    expect(restored.header.magic).toBe(DEMO_MAGIC);
    expect(restored.header.formatVersion).toBe(DEMO_FORMAT_VERSION);
    expect(restored.header.duration).toBeCloseTo(10.5, 4);
    expect(restored.header.totalFrames).toBe(3);
    expect(restored.header.projectileEventCount).toBe(2);
    expect(restored.header.targetEventCount).toBe(1);
    expect(restored.header.description).toBe('Test demo clip');
    expect(restored.header.startPosX).toBeCloseTo(10.5, 4);
    expect(restored.header.projectileLifetime).toBeCloseTo(3.5, 4);

    // Frames
    expect(restored.frames.length).toBe(3);
    expect(restored.frames[0].frameNumber).toBe(0);
    expect(restored.frames[0].timestamp).toBeCloseTo(0.0, 4);
    expect(restored.frames[0].posX).toBeCloseTo(10.5, 4);
    expect(restored.frames[0].posY).toBeCloseTo(20.0, 4);
    expect(restored.frames[0].posZ).toBeCloseTo(-5.3, 4);
    expect(restored.frames[0].velX).toBeCloseTo(1.0, 4);
    expect(restored.frames[0].velZ).toBeCloseTo(3.5, 4);
    expect(restored.frames[0].yaw).toBeCloseTo(1.57, 4);
    expect(restored.frames[0].pitch).toBeCloseTo(-0.3, 4);
    expect(restored.frames[0].inputFlags).toBe(0b10101);
    expect(restored.frames[0].mouseDeltaX).toBe(-100);
    expect(restored.frames[0].mouseDeltaY).toBe(50);
    expect(restored.frames[0].jetpackFlags).toBe(1);
    expect(restored.frames[0].jetpackFuel).toBeCloseTo(42.5, 4);

    // Projectile events
    expect(restored.projectileEvents.length).toBe(2);
    expect(restored.projectileEvents[0].eventType).toBe(ProjectileEventType.Fired);
    expect(restored.projectileEvents[0].timestamp).toBeCloseTo(1.0, 4);
    expect(restored.projectileEvents[0].projectileId).toBe(1);
    expect(restored.projectileEvents[0].weaponType).toBe(2);
    expect(restored.projectileEvents[1].eventType).toBe(ProjectileEventType.Hit);
    expect(restored.projectileEvents[1].timestamp).toBeCloseTo(4.5, 4);
    expect(restored.projectileEvents[1].targetId).toBe(42);
    expect(restored.projectileEvents[1].hasPeakPosition).toBe(true);
    expect(restored.projectileEvents[1].peakPosY).toBeCloseTo(90, 4);

    // Target events
    expect(restored.targetEvents.length).toBe(1);
    expect(restored.targetEvents[0].eventType).toBe(TargetEventType.Spawned);
    expect(restored.targetEvents[0].timestamp).toBeCloseTo(0.5, 4);
    expect(restored.targetEvents[0].targetId).toBe(42);
    expect(restored.targetEvents[0].targetType).toBe(3);
    expect(restored.targetEvents[0].health).toBeCloseTo(100, 4);
  });

  it('rejects bad magic', () => {
    const original = makeDemoFile();
    const buffer = DemoSerializer.serialize(original);
    const view = new DataView(buffer);
    view.setUint8(0, 0x00); // corrupt magic
    expect(() => DemoSerializer.deserialize(buffer)).toThrow(/bad magic/);
  });

  it('rejects unsupported format version', () => {
    const original = makeDemoFile();
    const buffer = DemoSerializer.serialize(original);
    const view = new DataView(buffer);
    view.setInt32(1, 999, true); // future version
    expect(() => DemoSerializer.deserialize(buffer)).toThrow(/Unsupported demo format version/);
  });

  it('detects checksum mismatch on corrupted data', () => {
    const original = makeDemoFile();
    const buffer = DemoSerializer.serialize(original);
    const view = new DataView(buffer);
    // Corrupt a frame byte (after header, after checksum)
    view.setFloat32(200, 999.999, true);
    expect(() => DemoSerializer.deserialize(buffer)).toThrow(/checksum mismatch/);
  });

  it('detects truncated file', () => {
    const original = makeDemoFile();
    const buffer = DemoSerializer.serialize(original);
    const truncated = buffer.slice(0, 50); // way too short
    expect(() => DemoSerializer.deserialize(truncated)).toThrow(/truncated|bad magic/);
  });

  it('handles empty demo (zero frames, zero events)', () => {
    const header = createHeader();
    header.duration = 0;
    const data: DemoFile = {
      header,
      frames: [],
      projectileEvents: [],
      targetEvents: [],
    };
    const buffer = DemoSerializer.serialize(data);
    const restored = DemoSerializer.deserialize(buffer);
    expect(restored.frames.length).toBe(0);
    expect(restored.projectileEvents.length).toBe(0);
    expect(restored.targetEvents.length).toBe(0);
  });
});
