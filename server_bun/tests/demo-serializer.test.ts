import { describe, it, expect } from 'bun:test';
import { DemoSerializer } from '../../client/src/demo/DemoSerializer.ts';
import {
  DEMO_MAGIC, DEMO_FORMAT_VERSION,
  ProjectileEventType, TargetEventType,
  createFrame, createHeader,
  type DemoFile,
} from '../../client/src/demo/types.ts';
import { hmapDownsample, hmapToField, hmapMatches, hmapFingerprint } from '../../client/src/demo/demoHmap.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';

function makeDemoFile(): DemoFile {
  const frames = [
    createFrame(0, 0.0),
    createFrame(1, 0.016),
    createFrame(2, 0.033),
  ];
  const f0 = frames[0]!;
  const f1 = frames[1]!;
  f0.posX = 10.5; f0.posY = 20.0; f0.posZ = -5.3;
  f0.velX = 1.0; f0.velY = 0.0; f0.velZ = 3.5;
  f0.yaw = 1.57; f0.pitch = -0.3;
  f0.inputFlags = 0b10101;
  f0.mouseDeltaX = -100;
  f0.mouseDeltaY = 50;
  f0.jetpackFlags = 1;
  f0.jetpackFuel = 42.5;

  f1.posX = 11.0; f1.posY = 20.1; f1.posZ = -5.0;

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
  header.room = 'quicksand';
  header.mode = 'tdm';
  header.playerName = 'JP';

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

  const roster = [{ name: 'bot-1' }, { name: 'bot-2' }];
  const remoteFrames = [
    {
      timestamp: 0.1, rosterIdx: 0,
      posX: 1, posY: 2, posZ: 3,
      velX: 4, velY: 5, velZ: 6,
      yaw: 0.5, pitch: -0.2, flags: 0,
    },
    {
      timestamp: 0.15, rosterIdx: 1,
      posX: 7, posY: 8, posZ: 9,
      velX: -1, velY: 0, velZ: 1,
      yaw: 1.5, pitch: 0.1, flags: 2,
    },
  ];

  return { header, frames, projectileEvents, targetEvents, roster, remoteFrames };
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
    const rf0 = restored.frames[0]!;
    expect(rf0.frameNumber).toBe(0);
    expect(rf0.timestamp).toBeCloseTo(0.0, 4);
    expect(rf0.posX).toBeCloseTo(10.5, 4);
    expect(rf0.posY).toBeCloseTo(20.0, 4);
    expect(rf0.posZ).toBeCloseTo(-5.3, 4);
    expect(rf0.velX).toBeCloseTo(1.0, 4);
    expect(rf0.velZ).toBeCloseTo(3.5, 4);
    expect(rf0.yaw).toBeCloseTo(1.57, 4);
    expect(rf0.pitch).toBeCloseTo(-0.3, 4);
    expect(rf0.inputFlags).toBe(0b10101);
    expect(rf0.mouseDeltaX).toBe(-100);
    expect(rf0.mouseDeltaY).toBe(50);
    expect(rf0.jetpackFlags).toBe(1);
    expect(rf0.jetpackFuel).toBeCloseTo(42.5, 4);

    // Projectile events
    expect(restored.projectileEvents.length).toBe(2);
    const pe0 = restored.projectileEvents[0]!;
    const pe1 = restored.projectileEvents[1]!;
    expect(pe0.eventType).toBe(ProjectileEventType.Fired);
    expect(pe0.timestamp).toBeCloseTo(1.0, 4);
    expect(pe0.projectileId).toBe(1);
    expect(pe0.weaponType).toBe(2);
    expect(pe1.eventType).toBe(ProjectileEventType.Hit);
    expect(pe1.timestamp).toBeCloseTo(4.5, 4);
    expect(pe1.targetId).toBe(42);
    expect(pe1.hasPeakPosition).toBe(true);
    expect(pe1.peakPosY).toBeCloseTo(90, 4);

    // Target events
    expect(restored.targetEvents.length).toBe(1);
    const te0 = restored.targetEvents[0]!;
    expect(te0.eventType).toBe(TargetEventType.Spawned);
    expect(te0.timestamp).toBeCloseTo(0.5, 4);
    expect(te0.targetId).toBe(42);
    expect(te0.targetType).toBe(3);
    expect(te0.health).toBeCloseTo(100, 4);

    // v3 context + roster + remote frames
    expect(restored.header.room).toBe('quicksand');
    expect(restored.header.mode).toBe('tdm');
    expect(restored.header.playerName).toBe('JP');
    expect(restored.roster.length).toBe(2);
    expect(restored.roster[1]!.name).toBe('bot-2');
    expect(restored.remoteFrames.length).toBe(2);
    const rf1 = restored.remoteFrames[1]!;
    expect(rf1.rosterIdx).toBe(1);
    expect(rf1.posX).toBeCloseTo(7, 4);
    expect(rf1.flags).toBe(2);
  });

  it('rejects a remote frame referencing a missing roster index', () => {
    const original = makeDemoFile();
    original.remoteFrames[0]!.rosterIdx = 9; // roster only has 2
    const buffer = DemoSerializer.serialize(original);
    expect(() => DemoSerializer.deserialize(buffer)).toThrow(/roster idx/);
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

  it('round-trips the v5 heightmap trailer and tolerates its absence', () => {
    const original = makeDemoFile();
    original.heightmap = {
      gridN: 4, heightScale: 1.5, worldScale: 2048, srcHash: 0xDEADBEEF,
      data: new Uint8Array([0, 32, 64, 96, 128, 160, 192, 224, 255, 16, 48, 80, 112, 144, 176, 208]),
    };
    const restored = DemoSerializer.deserialize(DemoSerializer.serialize(original));
    expect(restored.heightmap).toBeDefined();
    expect(restored.heightmap!.gridN).toBe(4);
    expect(restored.heightmap!.heightScale).toBeCloseTo(1.5, 5);
    expect(restored.heightmap!.worldScale).toBeCloseTo(2048, 1);
    expect(restored.heightmap!.srcHash).toBe(0xDEADBEEF);
    expect([...restored.heightmap!.data]).toEqual([...original.heightmap.data]);

    // Same file without the section → no heightmap, no parse error.
    const plain = makeDemoFile();
    const restored2 = DemoSerializer.deserialize(DemoSerializer.serialize(plain));
    expect(restored2.heightmap).toBeUndefined();
  });

  it('rejects a corrupt HMAP section', () => {
    const original = makeDemoFile();
    original.heightmap = {
      gridN: 8, heightScale: 1, worldScale: 1500, srcHash: 1,
      data: new Uint8Array(64),
    };
    const buffer = DemoSerializer.serialize(original);
    // Truncate inside the hmap payload → CRC catches it first.
    expect(() => DemoSerializer.deserialize(buffer.slice(0, buffer.byteLength - 4))).toThrow();
  });

  it('handles empty demo (zero frames, zero events)', () => {
    const header = createHeader();
    header.duration = 0;
    const data: DemoFile = {
      header,
      frames: [],
      projectileEvents: [],
      targetEvents: [],
      roster: [],
      remoteFrames: [],
    };
    const buffer = DemoSerializer.serialize(data);
    const restored = DemoSerializer.deserialize(buffer);
    expect(restored.frames.length).toBe(0);
    expect(restored.projectileEvents.length).toBe(0);
    expect(restored.targetEvents.length).toBe(0);
  });
});

describe('demoHmap helpers', () => {
  // 16² gradient field: height rises eastward — easy to check by hand.
  function makeField(): Heightfield {
    const data = new Uint8Array(16 * 16);
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {data[z * 16 + x] = x * 16;}
    return { size: 16, data, stride: 1, heightScale: 1, worldScale: 1500 };
  }

  it('downsamples a field into a small grid that resamples close to the source', () => {
    const field = makeField();
    const hm = hmapDownsample(field, 8);
    expect(hm.data.length).toBe(64);
    expect(hm.srcHash).toBe(hmapFingerprint(field));
    const coarse = hmapToField(hm);
    // Interior sample on a gradient rising ~15m per output cell: the
    // honest bound is ~half a cell span — the fallback preserves shape,
    // not survey data.
    const x = 400, z = 700;
    expect(Math.abs(hmHeight(coarse, x, z) - hmHeight(field, x, z))).toBeLessThan(10);
    // But the TREND survives exactly: east is higher than west.
    expect(hmHeight(coarse, 1200, 700)).toBeGreaterThan(hmHeight(coarse, 200, 700));
  });

  it('matches the source field and rejects a different terrain', () => {
    const field = makeField();
    const hm = hmapDownsample(field, 8);
    expect(hmapMatches(hm, field)).toBe(true);
    const flipped = makeField();
    flipped.data = flipped.data.map((v) => 255 - v);
    expect(hmapMatches(hm, flipped)).toBe(false);
  });
});
