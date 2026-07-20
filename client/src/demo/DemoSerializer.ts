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
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Write string: uint16 length + UTF-8 bytes
function writeString(view: DataView, offset: number, str: string): number {
  const bytes = new TextEncoder().encode(str);
  view.setUint16(offset, bytes.length, true);
  offset += 2;
  for (let i = 0; i < bytes.length; i++) {
    view.setUint8(offset++, bytes[i]);
  }
  return offset;
}

function readString(view: DataView, offset: number): [string, number] {
  if (offset + 2 > view.byteLength) {
    throw new Error('Demo file truncated: cannot read string length');
  }
  const len = view.getUint16(offset, true);
  offset += 2;
  if (offset + len > view.byteLength) {
    throw new Error(`Demo file truncated: string needs ${len} bytes but only ${view.byteLength - offset} remain`);
  }
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, len);
  const str = new TextDecoder().decode(bytes);
  return [str, offset + len];
}

// Check that enough bytes remain for a read of `size` bytes at `offset`.
function ensureBytes(view: DataView, offset: number, size: number, what: string): void {
  if (offset + size > view.byteLength) {
    throw new Error(`Demo file truncated: cannot read ${what} at offset ${offset} (need ${size} bytes, have ${view.byteLength - offset})`);
  }
}

// Frame size: 2 + 4 + 12 + 12 + 8 + 1 + 2 + 2 + 1 + 4 = 48 bytes
const FRAME_SIZE = 48;
// Projectile event size: 1 + 4 + 12 + 12 + 2 + 1 + 12 + 2 + 1 + 12 = 59 bytes
const PROJECTILE_EVENT_SIZE = 59;
// Target event size: 1 + 4 + 12 + 12 + 2 + 1 + 4 + 1 + 12 = 49 bytes
const TARGET_EVENT_SIZE = 49;

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
    const view = new DataView(buffer);
    let offset = 0;

    // Validate minimum size for header start
    ensureBytes(view, offset, 1 + 4, 'magic + formatVersion');

    // Validate magic
    const magic = view.getUint8(offset++);
    if (magic !== DEMO_MAGIC) {
      throw new Error(`Invalid demo file: bad magic 0x${magic.toString(16)}`);
    }

    const formatVersion = view.getInt32(offset, true); offset += 4;
    if (formatVersion > DEMO_FORMAT_VERSION) {
      throw new Error(`Unsupported demo format version ${formatVersion} (max ${DEMO_FORMAT_VERSION})`);
    }

    const [gameVersion, off1] = readString(view, offset); offset = off1;
    const timestamp = view.getFloat64(offset, true); offset += 8;
    const duration = view.getFloat32(offset, true); offset += 4;
    const totalFrames = view.getUint32(offset, true); offset += 4;
    const projectileEventCount = view.getUint32(offset, true); offset += 4;
    const targetEventCount = view.getUint32(offset, true); offset += 4;
    const checksum = view.getUint32(offset, true); offset += 4;
    const [description, off2] = readString(view, offset); offset = off2;
    const startPosX = view.getFloat32(offset, true); offset += 4;
    const startPosY = view.getFloat32(offset, true); offset += 4;
    const startPosZ = view.getFloat32(offset, true); offset += 4;
    const startYaw = view.getFloat32(offset, true); offset += 4;
    const startPitch = view.getFloat32(offset, true); offset += 4;
    const startVelX = view.getFloat32(offset, true); offset += 4;
    const startVelY = view.getFloat32(offset, true); offset += 4;
    const startVelZ = view.getFloat32(offset, true); offset += 4;

    // projectileLifetime added in format v2; absent in v1
    let projectileLifetime = 0;
    if (formatVersion >= 2) {
      projectileLifetime = view.getFloat32(offset, true); offset += 4;
    }

    // Verify checksum
    const checksumOffset = 1 + 4 + 2 + new TextEncoder().encode(gameVersion).length + 8 + 4 + 4 + 4 + 4;
    const dataAfterChecksum = new Uint8Array(buffer, checksumOffset + 4);
    const computedChecksum = crc32(dataAfterChecksum);
    if (computedChecksum !== checksum) {
      throw new Error('Demo file checksum mismatch - file may be corrupted');
    }

    // Read frames
    ensureBytes(view, offset, 4, 'frame count');
    const frameCount = view.getUint32(offset, true); offset += 4;
    if (frameCount > 720000) throw new Error(`Invalid frame count: ${frameCount} (max 720000)`);
    ensureBytes(view, offset, frameCount * FRAME_SIZE, 'frame array');
    const frames: DemoFrame[] = Array.from({ length: frameCount });
    for (let i = 0; i < frameCount; i++) {
      frames[i] = {
        frameNumber: view.getUint16(offset, true),
        timestamp: view.getFloat32(offset + 2, true),
        posX: view.getFloat32(offset + 6, true),
        posY: view.getFloat32(offset + 10, true),
        posZ: view.getFloat32(offset + 14, true),
        velX: view.getFloat32(offset + 18, true),
        velY: view.getFloat32(offset + 22, true),
        velZ: view.getFloat32(offset + 26, true),
        yaw: view.getFloat32(offset + 30, true),
        pitch: view.getFloat32(offset + 34, true),
        inputFlags: view.getUint8(offset + 38),
        mouseDeltaX: view.getInt16(offset + 39, true),
        mouseDeltaY: view.getInt16(offset + 41, true),
        jetpackFlags: view.getUint8(offset + 43),
        jetpackFuel: view.getFloat32(offset + 44, true),
      };
      offset += FRAME_SIZE;
    }

    // Read projectile events
    ensureBytes(view, offset, 4, 'projectile event count');
    const projCount = view.getUint32(offset, true); offset += 4;
    if (projCount > 100000) throw new Error(`Invalid projectile event count: ${projCount} (max 100000)`);
    ensureBytes(view, offset, projCount * PROJECTILE_EVENT_SIZE, 'projectile event array');
    const projectileEvents: ProjectileEvent[] = Array.from({ length: projCount });
    for (let i = 0; i < projCount; i++) {
      const eventTypeVal = view.getUint8(offset);
      if (eventTypeVal > 3) {
        throw new Error(`Invalid projectile event type ${eventTypeVal} at event ${i} (max 3)`);
      }
      projectileEvents[i] = {
        eventType: eventTypeVal as ProjectileEventType,
        timestamp: view.getFloat32(offset + 1, true),
        posX: view.getFloat32(offset + 5, true),
        posY: view.getFloat32(offset + 9, true),
        posZ: view.getFloat32(offset + 13, true),
        velX: view.getFloat32(offset + 17, true),
        velY: view.getFloat32(offset + 21, true),
        velZ: view.getFloat32(offset + 25, true),
        projectileId: view.getUint16(offset + 29, true),
        weaponType: view.getUint8(offset + 31),
        surfaceNormalX: view.getFloat32(offset + 32, true),
        surfaceNormalY: view.getFloat32(offset + 36, true),
        surfaceNormalZ: view.getFloat32(offset + 40, true),
        targetId: view.getUint16(offset + 44, true),
        hasPeakPosition: view.getUint8(offset + 46) !== 0,
        peakPosX: view.getFloat32(offset + 47, true),
        peakPosY: view.getFloat32(offset + 51, true),
        peakPosZ: view.getFloat32(offset + 55, true),
      };
      offset += PROJECTILE_EVENT_SIZE;
    }

    // Read target events
    ensureBytes(view, offset, 4, 'target event count');
    const targetCount = view.getUint32(offset, true); offset += 4;
    if (targetCount > 100000) throw new Error(`Invalid target event count: ${targetCount} (max 100000)`);
    ensureBytes(view, offset, targetCount * TARGET_EVENT_SIZE, 'target event array');
    const targetEvents: TargetEvent[] = Array.from({ length: targetCount });
    for (let i = 0; i < targetCount; i++) {
      const eventTypeVal = view.getUint8(offset);
      if (eventTypeVal > 4) {
        throw new Error(`Invalid target event type ${eventTypeVal} at event ${i} (max 4)`);
      }
      targetEvents[i] = {
        eventType: eventTypeVal as TargetEventType,
        timestamp: view.getFloat32(offset + 1, true),
        posX: view.getFloat32(offset + 5, true),
        posY: view.getFloat32(offset + 9, true),
        posZ: view.getFloat32(offset + 13, true),
        velX: view.getFloat32(offset + 17, true),
        velY: view.getFloat32(offset + 21, true),
        velZ: view.getFloat32(offset + 25, true),
        targetId: view.getUint16(offset + 29, true),
        targetType: view.getUint8(offset + 31),
        health: view.getFloat32(offset + 32, true),
        hasPeakPosition: view.getUint8(offset + 36) !== 0,
        peakPosX: view.getFloat32(offset + 37, true),
        peakPosY: view.getFloat32(offset + 41, true),
        peakPosZ: view.getFloat32(offset + 45, true),
      };
      offset += TARGET_EVENT_SIZE;
    }

    return {
      header: {
        magic, formatVersion, gameVersion, timestamp, duration,
        totalFrames, projectileEventCount, targetEventCount, checksum, description,
        startPosX, startPosY, startPosZ, startYaw, startPitch,
        startVelX, startVelY, startVelZ, projectileLifetime,
      },
      frames,
      projectileEvents,
      targetEvents,
    };
  }

  // Serialize to Blob for file download
  static toBlob(data: DemoFile): Blob {
    const buffer = this.serialize(data);
    return new Blob([buffer], { type: 'application/octet-stream' });
  }
}
