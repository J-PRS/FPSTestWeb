// Binary serializer for demo files.
// Uses DataView for efficient binary read/write.
// Format: magic(1) + version(4) + header fields + frames + events

import {
  DemoFrame, ProjectileEvent, TargetEvent,
  ProjectileEventType, TargetEventType,
  DEMO_MAGIC, DEMO_FORMAT_VERSION,
  type DemoFile,
} from './types.js';

// CRC32 lookup table
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]!) & 0xFF]! ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Write string: uint16 length + UTF-8 bytes
function writeString(view: DataView, offset: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  view.setUint16(offset, bytes.length, true);
  offset += 2;
  for (let i = 0; i < bytes.length; i++) {
    view.setUint8(offset++, bytes[i]!);
  }
  return offset;
}

// Frame size: 2 + 4 + 12 + 12 + 8 + 1 + 2 + 2 + 1 + 4 = 48 bytes
const FRAME_SIZE = 48;
// Projectile event size: 1 + 4 + 12 + 12 + 2 + 1 + 12 + 2 + 1 + 12 = 59 bytes
const PROJECTILE_EVENT_SIZE = 59;
// Target event size: 1 + 4 + 12 + 12 + 2 + 1 + 4 + 1 + 12 = 49 bytes
const TARGET_EVENT_SIZE = 49;

// ---------------------------------------------------------------------------
// Backwards-compatibility strategy
// ---------------------------------------------------------------------------
// DEMO_FORMAT_VERSION is the current format. deserialize() accepts any file
// with 1 <= formatVersion <= DEMO_FORMAT_VERSION. Each version bump that adds
// header fields must be gated with `if (formatVersion >= N)` so older files
// parse correctly. Frame and event structures are fixed-size and have never
// changed between versions — if a future version changes them, add per-version
// size constants and a version-gated read path.
//
// Version history:
//   v1: original format (no projectileLifetime in header)
//   v2: added projectileLifetime (float32) at end of header
// ---------------------------------------------------------------------------

export class DemoSerializer {

  static serialize(data: DemoFile): ArrayBuffer {
    // Calculate total size
    const headerSize = 1 + 4 + 2 + 0 + 8 + 4 + 4 + 4 + 4 + 4 + 2 + 0 + 12 + 8 + 12 + 4; // fixed + 2 strings + projectileLifetime
    const gameVersionBytes = new TextEncoder().encode(data.header.gameVersion);
    const descBytes = new TextEncoder().encode(data.header.description);
    const totalHeaderSize = headerSize + gameVersionBytes.length + descBytes.length;
    const framesSize = 4 + data.frames.length * FRAME_SIZE; // uint32 frame count + frames
    const projEventsSize = 4 + data.projectileEvents.length * PROJECTILE_EVENT_SIZE;
    const targetEventsSize = 4 + data.targetEvents.length * TARGET_EVENT_SIZE;
    const totalSize = totalHeaderSize + framesSize + projEventsSize + targetEventsSize;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Header
    view.setUint8(offset++, data.header.magic);
    view.setInt32(offset, data.header.formatVersion, true); offset += 4;
    offset = writeString(view, offset, data.header.gameVersion);
    view.setFloat64(offset, data.header.timestamp, true); offset += 8;
    view.setFloat32(offset, data.header.duration, true); offset += 4;
    view.setUint32(offset, data.header.totalFrames, true); offset += 4;
    view.setUint32(offset, data.header.projectileEventCount, true); offset += 4;
    view.setUint32(offset, data.header.targetEventCount, true); offset += 4;
    view.setUint32(offset, 0, true); offset += 4; // checksum placeholder
    offset = writeString(view, offset, data.header.description);
    view.setFloat32(offset, data.header.startPosX, true); offset += 4;
    view.setFloat32(offset, data.header.startPosY, true); offset += 4;
    view.setFloat32(offset, data.header.startPosZ, true); offset += 4;
    view.setFloat32(offset, data.header.startYaw, true); offset += 4;
    view.setFloat32(offset, data.header.startPitch, true); offset += 4;
    view.setFloat32(offset, data.header.startVelX, true); offset += 4;
    view.setFloat32(offset, data.header.startVelY, true); offset += 4;
    view.setFloat32(offset, data.header.startVelZ, true); offset += 4;
    view.setFloat32(offset, data.header.projectileLifetime, true); offset += 4;

    // Frames
    view.setUint32(offset, data.frames.length, true); offset += 4;
    for (const f of data.frames) {
      view.setUint16(offset, f.frameNumber, true); offset += 2;
      view.setFloat32(offset, f.timestamp, true); offset += 4;
      view.setFloat32(offset, f.posX, true); offset += 4;
      view.setFloat32(offset, f.posY, true); offset += 4;
      view.setFloat32(offset, f.posZ, true); offset += 4;
      view.setFloat32(offset, f.velX, true); offset += 4;
      view.setFloat32(offset, f.velY, true); offset += 4;
      view.setFloat32(offset, f.velZ, true); offset += 4;
      view.setFloat32(offset, f.yaw, true); offset += 4;
      view.setFloat32(offset, f.pitch, true); offset += 4;
      view.setUint8(offset++, f.inputFlags);
      view.setInt16(offset, f.mouseDeltaX, true); offset += 2;
      view.setInt16(offset, f.mouseDeltaY, true); offset += 2;
      view.setUint8(offset++, f.jetpackFlags);
      view.setFloat32(offset, f.jetpackFuel, true); offset += 4;
    }

    // Projectile events
    view.setUint32(offset, data.projectileEvents.length, true); offset += 4;
    for (const e of data.projectileEvents) {
      view.setUint8(offset++, e.eventType);
      view.setFloat32(offset, e.timestamp, true); offset += 4;
      view.setFloat32(offset, e.posX, true); offset += 4;
      view.setFloat32(offset, e.posY, true); offset += 4;
      view.setFloat32(offset, e.posZ, true); offset += 4;
      view.setFloat32(offset, e.velX, true); offset += 4;
      view.setFloat32(offset, e.velY, true); offset += 4;
      view.setFloat32(offset, e.velZ, true); offset += 4;
      view.setUint16(offset, e.projectileId, true); offset += 2;
      view.setUint8(offset++, e.weaponType);
      view.setFloat32(offset, e.surfaceNormalX, true); offset += 4;
      view.setFloat32(offset, e.surfaceNormalY, true); offset += 4;
      view.setFloat32(offset, e.surfaceNormalZ, true); offset += 4;
      view.setUint16(offset, e.targetId, true); offset += 2;
      view.setUint8(offset++, e.hasPeakPosition ? 1 : 0);
      view.setFloat32(offset, e.peakPosX, true); offset += 4;
      view.setFloat32(offset, e.peakPosY, true); offset += 4;
      view.setFloat32(offset, e.peakPosZ, true); offset += 4;
    }

    // Target events
    view.setUint32(offset, data.targetEvents.length, true); offset += 4;
    for (const e of data.targetEvents) {
      view.setUint8(offset++, e.eventType);
      view.setFloat32(offset, e.timestamp, true); offset += 4;
      view.setFloat32(offset, e.posX, true); offset += 4;
      view.setFloat32(offset, e.posY, true); offset += 4;
      view.setFloat32(offset, e.posZ, true); offset += 4;
      view.setFloat32(offset, e.velX, true); offset += 4;
      view.setFloat32(offset, e.velY, true); offset += 4;
      view.setFloat32(offset, e.velZ, true); offset += 4;
      view.setUint16(offset, e.targetId, true); offset += 2;
      view.setUint8(offset++, e.targetType);
      view.setFloat32(offset, e.health, true); offset += 4;
      view.setUint8(offset++, e.hasPeakPosition ? 1 : 0);
      view.setFloat32(offset, e.peakPosX, true); offset += 4;
      view.setFloat32(offset, e.peakPosY, true); offset += 4;
      view.setFloat32(offset, e.peakPosZ, true); offset += 4;
    }

    // Compute and write checksum over everything after the checksum field
    const checksumOffset = 1 + 4 + 2 + gameVersionBytes.length + 8 + 4 + 4 + 4 + 4;
    const dataAfterChecksum = new Uint8Array(buffer, checksumOffset + 4);
    const checksum = crc32(dataAfterChecksum);
    view.setUint32(checksumOffset, checksum, true);

    return buffer;
  }

  static deserialize(buffer: ArrayBuffer): DemoFile {
    const r = new Reader(buffer);
    const header = readDemoHeader(r, buffer);
    const frames = readFrames(r);
    const projectileEvents = readProjectileEvents(r);
    const targetEvents = readTargetEvents(r);
    validateHeaderCounts(header, frames, projectileEvents, targetEvents);
    return { header, frames, projectileEvents, targetEvents };
  }

  // Serialize to Blob for file download
  static toBlob(data: DemoFile): Blob {
    const buffer = this.serialize(data);
    return new Blob([buffer], { type: 'application/octet-stream' });
  }
}

// Little-endian cursor over an ArrayBuffer with bounds checking.
class Reader {
  private view: DataView;
  private offset = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  ensure(size: number, what: string): void {
    if (this.offset + size > this.view.byteLength) {
      throw new Error(`Demo file truncated: cannot read ${what}`);
    }
  }

  u8(): number { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  i16(): number { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  i32(): number { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  f32(): number { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  f64(): number { const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }

  str(): string {
    this.ensure(2, 'string length');
    const len = this.u16();
    this.ensure(len, `string of ${len} bytes`);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return new TextDecoder().decode(bytes);
  }
}

function readDemoHeader(r: Reader, buffer: ArrayBuffer): DemoFile['header'] {
  // Validate minimum size for header start
  r.ensure(1 + 4, 'magic + formatVersion');

  const magic = r.u8();
  if (magic !== DEMO_MAGIC) {
    throw new Error(`Invalid demo file: bad magic 0x${magic.toString(16)}`);
  }

  const formatVersion = r.i32();
  if (formatVersion < 1 || formatVersion > DEMO_FORMAT_VERSION) {
    throw new Error(`Unsupported demo format version ${formatVersion} (supported 1..${DEMO_FORMAT_VERSION})`);
  }

  const gameVersion = r.str();
  const timestamp = r.f64();
  const duration = r.f32();
  const totalFrames = r.u32();
  const projectileEventCount = r.u32();
  const targetEventCount = r.u32();
  const checksum = r.u32();
  const description = r.str();
  const startPosX = r.f32();
  const startPosY = r.f32();
  const startPosZ = r.f32();
  const startYaw = r.f32();
  const startPitch = r.f32();
  const startVelX = r.f32();
  const startVelY = r.f32();
  const startVelZ = r.f32();

  // projectileLifetime added in format v2; absent in v1
  const projectileLifetime = formatVersion >= 2 ? r.f32() : 0;

  // Verify checksum
  const checksumOffset = 1 + 4 + 2 + new TextEncoder().encode(gameVersion).length + 8 + 4 + 4 + 4 + 4;
  const dataAfterChecksum = new Uint8Array(buffer, checksumOffset + 4);
  if (crc32(dataAfterChecksum) !== checksum) {
    throw new Error('Demo file checksum mismatch - file may be corrupted');
  }

  return {
    magic, formatVersion, gameVersion, timestamp, duration,
    totalFrames, projectileEventCount, targetEventCount, checksum, description,
    startPosX, startPosY, startPosZ, startYaw, startPitch,
    startVelX, startVelY, startVelZ, projectileLifetime,
  };
}

// Read a count-prefixed array of fixed-size records, with a sanity cap.
function readRecordCount(r: Reader, what: string, recordSize: number, max: number): number {
  r.ensure(4, `${what} count`);
  const count = r.u32();
  if (count > max) throw new Error(`Invalid ${what} count: ${count} (max ${max})`);
  r.ensure(count * recordSize, `${what} array`);
  return count;
}

function readFrames(r: Reader): DemoFrame[] {
  const count = readRecordCount(r, 'frame', FRAME_SIZE, 720000);
  const frames: DemoFrame[] = Array.from({ length: count });
  for (let i = 0; i < count; i++) {
    frames[i] = {
      frameNumber: r.u16(),
      timestamp: r.f32(),
      posX: r.f32(), posY: r.f32(), posZ: r.f32(),
      velX: r.f32(), velY: r.f32(), velZ: r.f32(),
      yaw: r.f32(), pitch: r.f32(),
      inputFlags: r.u8(),
      mouseDeltaX: r.i16(),
      mouseDeltaY: r.i16(),
      jetpackFlags: r.u8(),
      jetpackFuel: r.f32(),
    };
  }
  return frames;
}

function readProjectileEvents(r: Reader): ProjectileEvent[] {
  const count = readRecordCount(r, 'projectile event', PROJECTILE_EVENT_SIZE, 100000);
  const events: ProjectileEvent[] = Array.from({ length: count });
  for (let i = 0; i < count; i++) {
    const eventTypeVal = r.u8();
    if (eventTypeVal > 3) {
      throw new Error(`Invalid projectile event type ${eventTypeVal} at event ${i} (max 3)`);
    }
    events[i] = {
      eventType: eventTypeVal as ProjectileEventType,
      timestamp: r.f32(),
      posX: r.f32(), posY: r.f32(), posZ: r.f32(),
      velX: r.f32(), velY: r.f32(), velZ: r.f32(),
      projectileId: r.u16(),
      weaponType: r.u8(),
      surfaceNormalX: r.f32(), surfaceNormalY: r.f32(), surfaceNormalZ: r.f32(),
      targetId: r.u16(),
      hasPeakPosition: r.u8() !== 0,
      peakPosX: r.f32(), peakPosY: r.f32(), peakPosZ: r.f32(),
    };
  }
  return events;
}

function readTargetEvents(r: Reader): TargetEvent[] {
  const count = readRecordCount(r, 'target event', TARGET_EVENT_SIZE, 100000);
  const events: TargetEvent[] = Array.from({ length: count });
  for (let i = 0; i < count; i++) {
    const eventTypeVal = r.u8();
    if (eventTypeVal > 4) {
      throw new Error(`Invalid target event type ${eventTypeVal} at event ${i} (max 4)`);
    }
    events[i] = {
      eventType: eventTypeVal as TargetEventType,
      timestamp: r.f32(),
      posX: r.f32(), posY: r.f32(), posZ: r.f32(),
      velX: r.f32(), velY: r.f32(), velZ: r.f32(),
      targetId: r.u16(),
      targetType: r.u8(),
      health: r.f32(),
      hasPeakPosition: r.u8() !== 0,
      peakPosX: r.f32(), peakPosY: r.f32(), peakPosZ: r.f32(),
    };
  }
  return events;
}

// Validate header counts against actual array lengths (catches silent corruption
// where the header count prefixes disagree with the per-array count prefixes).
function validateHeaderCounts(header: DemoFile['header'], frames: DemoFrame[], projectileEvents: ProjectileEvent[], targetEvents: TargetEvent[]): void {
  if (header.totalFrames !== frames.length) {
    throw new Error(`Demo file header totalFrames (${header.totalFrames}) != actual frame count (${frames.length})`);
  }
  if (header.projectileEventCount !== projectileEvents.length) {
    throw new Error(`Demo file header projectileEventCount (${header.projectileEventCount}) != actual (${projectileEvents.length})`);
  }
  if (header.targetEventCount !== targetEvents.length) {
    throw new Error(`Demo file header targetEventCount (${header.targetEventCount}) != actual (${targetEvents.length})`);
  }
}
