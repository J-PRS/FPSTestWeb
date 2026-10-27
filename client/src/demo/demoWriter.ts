// Binary serializer for demo files.
// Uses DataView for efficient binary read/write.
// Format: magic(1) + version(4) + header fields + frames + events

import type { DemoFile } from './types.js';
import { getRunSeed } from './demoSeed.js';
import { demoTableHash } from './demoTables.js';

// CRC32 lookup table

// Writer half of the demo codec — record encoders + serialize(). The
// reader lives in demoReader.ts; record sizes are shared from here.
export const crcTable = ((): Uint32Array<ArrayBuffer> => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 1) ? (0xED_B8_83_20 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xFF_FF_FF_FF;
  for (const b of data) {
    crc = crcTable[(crc ^ b) & 0xFF]! ^ (crc >>> 8);
  }
  return (crc ^ 0xFF_FF_FF_FF) >>> 0;
}

// Write string: uint16 length + UTF-8 bytes
function writeString(view: DataView, pOffset: number, str: string): number {
  let offset = pOffset;
  const bytes = new TextEncoder().encode(str);
  view.setUint16(offset, bytes.length, true);
  offset += 2;
  for (const b of bytes) {
    view.setUint8(((offset += 1) - 1), b);
  }
  return offset;
}

// Frame size: 2 + 4 + 12 + 12 + 8 + 1 + 2 + 2 + 1 + 4 + 1 + 4 = 53 bytes
// (v8 appends u16 health + u16 armor). v4-7 read at 49, older at 48.
export const FRAME_SIZE = 53;
export const FRAME_SIZE_V7 = 49;
// Projectile event size: 1 + 4 + 12 + 12 + 2 + 1 + 12 + 2 + 1 + 12 + 1 = 60
// bytes (v6 appended targetType). v5 and older read at 59.
export const PROJECTILE_EVENT_SIZE = 60;
// Target event size: 1 + 4 + 12 + 12 + 2 + 1 + 4 + 1 + 12 = 49 bytes
export const TARGET_EVENT_SIZE = 49;
// Remote frame size: 4 + 2 + 12 + 12 + 4 + 4 + 1 + 7 = 46 bytes
// (v8 appends a 7-byte meta tail: team/hp/held/sheep/cls/status/wid).
// v7 and older read at 39.
export const REMOTE_FRAME_SIZE = 46;
export const REMOTE_FRAME_SIZE_V7 = 39;

// v5 trailer: tagged optional sections after remoteFrames — each is
// u8 tag + u32 payloadLen + payload. Unknown tags are skipped by the
// reader, so future sections slot in without a version bump.
export const SECTION_HMAP = 1;
export const SECTION_TOKEN = 2;
// Seek checkpoints: u32 count + f32 ascending timestamps. Versionless by
// design — old readers skip the tag, old files just seek from 0.
export const SECTION_SNAP = 3;
// Map look spec — JSON {fog, weather, atmosphere} so a clip replays the
// mission haze/sky it was recorded under (rimrock haze != caldera night).
export const SECTION_ATMO = 4;

function writeHmapSection(view: DataView, pOffset: number, hm: DemoFile['heightmap']): number {
  let offset = pOffset;
  if (!hm) {return offset;}
  view.setUint8(((offset += 1) - 1), SECTION_HMAP);
  const lenPos = offset; offset += 4;
  const start = offset;
  view.setUint16(offset, hm.gridN, true); offset += 2;
  view.setFloat32(offset, hm.heightScale, true); offset += 4;
  view.setFloat32(offset, hm.worldScale, true); offset += 4;
  view.setUint32(offset, hm.srcHash, true); offset += 4;
  view.setUint32(offset, hm.data.length, true); offset += 4;
  for (const b of hm.data) {view.setUint8(((offset += 1) - 1), b);}
  if (hm.corr && hm.corr.idx.length > 0) {
    view.setUint16(offset, hm.corr.grid, true); offset += 2;
    view.setUint32(offset, hm.corr.idx.length, true); offset += 4;
    for (let i = 0; i < hm.corr.idx.length; i += 1) {
      view.setUint32(offset, hm.corr.idx[i]!, true); offset += 4;
      view.setInt8(((offset += 1) - 1), hm.corr.delta[i]!);
    }
  }
  view.setUint32(lenPos, offset - start, true);
  return offset;
}

function writeFrames(view: DataView, pOffset: number, frames: DemoFile['frames']): number {
  let offset = pOffset;
  view.setUint32(offset, frames.length, true); offset += 4;
  for (const f of frames) {
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
    view.setUint8(((offset += 1) - 1), f.inputFlags);
    view.setInt16(offset, f.mouseDeltaX, true); offset += 2;
    view.setInt16(offset, f.mouseDeltaY, true); offset += 2;
    view.setUint8(((offset += 1) - 1), f.jetpackFlags);
    view.setFloat32(offset, f.jetpackFuel, true); offset += 4;
    view.setUint8(((offset += 1) - 1), f.weaponType);
    view.setUint16(offset, f.health, true); offset += 2;
    view.setUint16(offset, f.armor, true); offset += 2;
  }
  return offset;
}

function writeProjEvents(view: DataView, pOffset: number, events: DemoFile['projectileEvents']): number {
  let offset = pOffset;
  view.setUint32(offset, events.length, true); offset += 4;
  for (const e of events) {
    view.setUint8(((offset += 1) - 1), e.eventType);
    view.setFloat32(offset, e.timestamp, true); offset += 4;
    view.setFloat32(offset, e.posX, true); offset += 4;
    view.setFloat32(offset, e.posY, true); offset += 4;
    view.setFloat32(offset, e.posZ, true); offset += 4;
    view.setFloat32(offset, e.velX, true); offset += 4;
    view.setFloat32(offset, e.velY, true); offset += 4;
    view.setFloat32(offset, e.velZ, true); offset += 4;
    view.setUint16(offset, e.projectileId, true); offset += 2;
    view.setUint8(((offset += 1) - 1), e.weaponType);
    view.setFloat32(offset, e.surfaceNormalX, true); offset += 4;
    view.setFloat32(offset, e.surfaceNormalY, true); offset += 4;
    view.setFloat32(offset, e.surfaceNormalZ, true); offset += 4;
    view.setUint16(offset, e.targetId, true); offset += 2;
    view.setUint8(((offset += 1) - 1), e.targetType);
    view.setUint8(((offset += 1) - 1), e.hasPeakPosition ? 1 : 0);
    view.setFloat32(offset, e.peakPosX, true); offset += 4;
    view.setFloat32(offset, e.peakPosY, true); offset += 4;
    view.setFloat32(offset, e.peakPosZ, true); offset += 4;
  }
  return offset;
}

function writeTargetEvents(view: DataView, pOffset: number, events: DemoFile['targetEvents']): number {
  let offset = pOffset;
  view.setUint32(offset, events.length, true); offset += 4;
  for (const e of events) {
    view.setUint8(((offset += 1) - 1), e.eventType);
    view.setFloat32(offset, e.timestamp, true); offset += 4;
    view.setFloat32(offset, e.posX, true); offset += 4;
    view.setFloat32(offset, e.posY, true); offset += 4;
    view.setFloat32(offset, e.posZ, true); offset += 4;
    view.setFloat32(offset, e.velX, true); offset += 4;
    view.setFloat32(offset, e.velY, true); offset += 4;
    view.setFloat32(offset, e.velZ, true); offset += 4;
    view.setUint16(offset, e.targetId, true); offset += 2;
    view.setUint8(((offset += 1) - 1), e.targetType);
    view.setFloat32(offset, e.health, true); offset += 4;
    view.setUint8(((offset += 1) - 1), e.hasPeakPosition ? 1 : 0);
    view.setFloat32(offset, e.peakPosX, true); offset += 4;
    view.setFloat32(offset, e.peakPosY, true); offset += 4;
    view.setFloat32(offset, e.peakPosZ, true); offset += 4;
  }
  return offset;
}

function writeRemoteFrames(view: DataView, pOffset: number, frames: DemoFile['remoteFrames']): number {
  let offset = pOffset;
  view.setUint32(offset, frames.length, true); offset += 4;
  for (const f of frames) {
    view.setFloat32(offset, f.timestamp, true); offset += 4;
    view.setUint16(offset, f.rosterIdx, true); offset += 2;
    view.setFloat32(offset, f.posX, true); offset += 4;
    view.setFloat32(offset, f.posY, true); offset += 4;
    view.setFloat32(offset, f.posZ, true); offset += 4;
    view.setFloat32(offset, f.velX, true); offset += 4;
    view.setFloat32(offset, f.velY, true); offset += 4;
    view.setFloat32(offset, f.velZ, true); offset += 4;
    view.setFloat32(offset, f.yaw, true); offset += 4;
    view.setFloat32(offset, f.pitch, true); offset += 4;
    view.setUint8(((offset += 1) - 1), f.flags);
    // v8 meta tail — 0 encodes "absent" so unset lanes stay free.
    view.setUint8(((offset += 1) - 1), f.team ?? 0);
    view.setUint8(((offset += 1) - 1), f.hp ?? 0);
    view.setUint8(((offset += 1) - 1), f.held ?? 0);
    view.setUint8(((offset += 1) - 1), f.sheep ?? 0);
    view.setUint8(((offset += 1) - 1), f.cls ?? 0);
    view.setUint8(((offset += 1) - 1), f.status ?? 0);
    view.setUint8(((offset += 1) - 1), f.wid ?? 0);
  }
  return offset;
}


export function serializeDemo(data: DemoFile): ArrayBuffer {

    // Calculate total size
    const headerSize = 1 + 4 + 2 + 0 + 8 + 4 + 4 + 4 + 4 + 4 + 2 + 0 + 12 + 8 + 12 + 4 + 2 + 0 + 2 + 0 + 2 + 0 + 4 + 4; // fixed + 5 strings + projectileLifetime + v6 tableHash + v7 runSeed
    const gameVersionBytes = new TextEncoder().encode(data.header.gameVersion);
    const descBytes = new TextEncoder().encode(data.header.description);
    const roomBytes = new TextEncoder().encode(data.header.room);
    const modeBytes = new TextEncoder().encode(data.header.mode);
    const playerNameBytes = new TextEncoder().encode(data.header.playerName);
    const totalHeaderSize = headerSize + gameVersionBytes.length + descBytes.length
      + roomBytes.length + modeBytes.length + playerNameBytes.length;
    const framesSize = 4 + data.frames.length * FRAME_SIZE; // uint32 frame count + frames
    const projEventsSize = 4 + data.projectileEvents.length * PROJECTILE_EVENT_SIZE;
    const targetEventsSize = 4 + data.targetEvents.length * TARGET_EVENT_SIZE;
    const rosterBytes = data.roster.map((r): number => 2 + new TextEncoder().encode(r.name).length);
    const rosterSize = 2 + rosterBytes.reduce((a, b): number => a + b, 0);
    const remoteFramesSize = 4 + data.remoteFrames.length * REMOTE_FRAME_SIZE;
    // v5 trailer: u8 section count + per-section tag/len/payload.
    const corrN = data.heightmap?.corr?.idx.length ?? 0;
    const hmapSize = data.heightmap ? 1 + 4 + 2 + 4 + 4 + 4 + 4 + data.heightmap.data.length + (corrN > 0 ? 2 + 4 + corrN * 5 : 0) : 0;
    const tokenSize = data.matchToken ? 1 + 4 + new TextEncoder().encode(JSON.stringify(data.matchToken)).length : 0;
    const snapCount = data.snapshots?.length ?? 0;
    const snapSize = snapCount > 0 ? 1 + 4 + 4 + snapCount * 4 : 0;
    const atmoBytes = data.atmo ? new TextEncoder().encode(JSON.stringify(data.atmo)) : null;
    const atmoSize = atmoBytes ? 1 + 4 + atmoBytes.length : 0;
    const trailerSize = 1 + hmapSize + tokenSize + snapSize + atmoSize;
    const totalSize = totalHeaderSize + framesSize + projEventsSize + targetEventsSize + rosterSize + remoteFramesSize + trailerSize;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Header
    view.setUint8(((offset += 1) - 1), data.header.magic);
    view.setInt32(offset, data.header.formatVersion, true); offset += 4;
    offset = writeString(view, offset, data.header.gameVersion);
    view.setFloat64(offset, data.header.timestamp, true); offset += 8;
    view.setFloat32(offset, data.header.duration, true); offset += 4;
    // Counts come from the arrays, not the header — a stale caller count
    // would otherwise serialize a clip the reader then rejects.
    view.setUint32(offset, data.frames.length, true); offset += 4;
    view.setUint32(offset, data.projectileEvents.length, true); offset += 4;
    view.setUint32(offset, data.targetEvents.length, true); offset += 4;
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
    offset = writeString(view, offset, data.header.room);
    offset = writeString(view, offset, data.header.mode);
    offset = writeString(view, offset, data.header.playerName);
    // Stamped at write time, not taken from the caller — the hash must
    // describe the tables the running build actually wrote ids against.
    view.setUint32(offset, demoTableHash(), true); offset += 4;
    // Run seed rides with the file — a verifier replays the whole dice
    // stream from it, so the header field is stamped at write time like
    // tableHash rather than trusting the caller's copy.
    view.setUint32(offset, getRunSeed(), true); offset += 4;

    offset = writeFrames(view, offset, data.frames);

    offset = writeProjEvents(view, offset, data.projectileEvents);

    offset = writeTargetEvents(view, offset, data.targetEvents);

    // Roster (u16 count + names)
    view.setUint16(offset, data.roster.length, true); offset += 2;
    for (const entry of data.roster) {
      offset = writeString(view, offset, entry.name);
    }

    offset = writeRemoteFrames(view, offset, data.remoteFrames);

    // v5 trailer sections — u8 count, then tag+len+payload per section.
    const tokenBytes = data.matchToken ? new TextEncoder().encode(JSON.stringify(data.matchToken)) : null;
    const snaps = data.snapshots ?? [];
    view.setUint8(((offset += 1) - 1), (data.heightmap ? 1 : 0) + (tokenBytes ? 1 : 0) + (snaps.length > 0 ? 1 : 0) + (atmoBytes ? 1 : 0));
    offset = writeHmapSection(view, offset, data.heightmap);
    if (atmoBytes) {
      view.setUint8(((offset += 1) - 1), SECTION_ATMO);
      view.setUint32(offset, atmoBytes.length, true); offset += 4;
      new Uint8Array(buffer, offset, atmoBytes.length).set(atmoBytes);
      offset += atmoBytes.length;
    }
    if (tokenBytes) {
      view.setUint8(((offset += 1) - 1), SECTION_TOKEN);
      view.setUint32(offset, tokenBytes.length, true); offset += 4;
      new Uint8Array(buffer, offset, tokenBytes.length).set(tokenBytes);
      offset += tokenBytes.length;
    }
    if (snaps.length > 0) {
      view.setUint8(((offset += 1) - 1), SECTION_SNAP);
      view.setUint32(offset, 4 + snaps.length * 4, true); offset += 4;
      view.setUint32(offset, snaps.length, true); offset += 4;
      for (const t of snaps) {view.setFloat32(offset, t, true); offset += 4;}
    }

    // Compute and write checksum over everything after the checksum field
    const checksumOffset = 1 + 4 + 2 + gameVersionBytes.length + 8 + 4 + 4 + 4 + 4;
    const dataAfterChecksum = new Uint8Array(buffer, checksumOffset + 4);
    const checksum = crc32(dataAfterChecksum);
    view.setUint32(checksumOffset, checksum, true);

    return buffer;
  }
