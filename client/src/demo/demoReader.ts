// Binary serializer for demo files.
// Uses DataView for efficient binary read/write.
// Format: magic(1) + version(4) + header fields + frames + events

import {
  type DemoFrame, type ProjectileEvent, type TargetEvent, type RemoteFrame,
  type ProjectileEventType, type TargetEventType,
  DEMO_MAGIC,DEMO_FORMAT_VERSION,
  type DemoFile,type DemoRosterEntry,type DemoHeightmap} from './types.js';

import type { ResultToken } from '../../../shared/resultToken.ts';
import { crc32, FRAME_SIZE, PROJECTILE_EVENT_SIZE, TARGET_EVENT_SIZE, REMOTE_FRAME_SIZE, SECTION_HMAP, SECTION_TOKEN } from './demoWriter.js';


// CRC32 lookup table

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
//   v3: added room/mode/playerName strings at end of header, plus roster
//       (player names) and remoteFrames sections after targetEvents
//   v4: appended weaponType (u8) to each frame record — older files read
//       at the 48-byte record size and default weaponType to 0
//   v5: tagged trailer sections (embedded heightmap)
//   v6: appended targetType (u8) to each projectileEvent record (older
//       files read at 59 bytes, default 0 = ball lane) and appended
//       tableHash (u32) at end of header
// ---------------------------------------------------------------------------

// Reader half of the demo codec — bounds-checked cursor + record readers
// + deserialize(). The writer lives in demoWriter.ts.
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

  get remaining(): number { return this.view.byteLength - this.offset; }
  bytes(n: number): Uint8Array {
    this.ensure(n, `${n} raw bytes`);
    const v = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, n);
    this.offset += n;
    return v;
  }
  skip(n: number): void { this.ensure(n, `skip of ${n} bytes`); this.offset += n; }

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

  // v3: match-context strings; absent in v1/v2
  const room = formatVersion >= 3 ? r.str() : '';
  const mode = formatVersion >= 3 ? r.str() : '';
  const playerName = formatVersion >= 3 ? r.str() : '';

  // v6: content-table fingerprint; 0 on older files (nothing to compare)
  const tableHash = formatVersion >= 6 ? r.u32() : 0;
  // v7: run's sim-RNG seed; 0 on older files (unverifiable stream)
  const runSeed = formatVersion >= 7 ? r.u32() : 0;

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
    room, mode, playerName, tableHash, runSeed,
  };
}

// Read a count-prefixed array of fixed-size records, with a sanity cap.
function readRecordCount(r: Reader, what: string, recordSize: number, max: number): number {
  r.ensure(4, `${what} count`);
  const count = r.u32();
  if (count > max) {throw new Error(`Invalid ${what} count: ${count} (max ${max})`);}
  r.ensure(count * recordSize, `${what} array`);
  return count;
}

function readFrames(r: Reader, hasWeaponType: boolean): DemoFrame[] {
  // v4 appended weaponType to the frame record; older files read at their
  // own record size and default to no held weapon shown.
  const recSize = hasWeaponType ? FRAME_SIZE : FRAME_SIZE - 1;
  const count = readRecordCount(r, 'frame', recSize, 720_000);
  const frames: DemoFrame[] = Array.from({ length: count });
  for (let i = 0; i < count; i += 1) {
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
      weaponType: hasWeaponType ? r.u8() : 0,
    };
  }
  return frames;
}

function readProjectileEvents(r: Reader, hasTargetType: boolean): ProjectileEvent[] {
  // v6 appended targetType to the record; older files read at 59 bytes.
  const recSize = hasTargetType ? PROJECTILE_EVENT_SIZE : PROJECTILE_EVENT_SIZE - 1;
  const count = readRecordCount(r, 'projectile event', recSize, 100_000);
  const events: ProjectileEvent[] = Array.from({ length: count });
  for (let i = 0; i < count; i += 1) {
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
      targetType: hasTargetType ? r.u8() : 0,
      hasPeakPosition: r.u8() !== 0,
      peakPosX: r.f32(), peakPosY: r.f32(), peakPosZ: r.f32(),
    };
  }
  return events;
}

function readTargetEvents(r: Reader): TargetEvent[] {
  const count = readRecordCount(r, 'target event', TARGET_EVENT_SIZE, 100_000);
  const events: TargetEvent[] = Array.from({ length: count });
  for (let i = 0; i < count; i += 1) {
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

function readRoster(r: Reader): DemoRosterEntry[] {
  r.ensure(2, 'roster count');
  const count = r.u16();
  // u16 field max — roster entries also come from kill-marker adoption,
  // not just live remotes, so a long recording's join churn can exceed 256.
  if (count > 65_535) {throw new Error(`Invalid roster count: ${count} (max 65535)`);}
  const roster: DemoRosterEntry[] = Array.from({ length: count });
  for (let i = 0; i < count; i += 1) {
    roster[i] = { name: r.str() };
  }
  return roster;
}

function readRemoteFrames(r: Reader, rosterSize: number): RemoteFrame[] {
  const count = readRecordCount(r, 'remote frame', REMOTE_FRAME_SIZE, 4_000_000);
  const frames: RemoteFrame[] = Array.from({ length: count });
  for (let i = 0; i < count; i += 1) {
    const timestamp = r.f32();
    const rosterIdx = r.u16();
    if (rosterIdx >= rosterSize) {
      throw new Error(`Remote frame ${i} references roster idx ${rosterIdx} (roster has ${rosterSize})`);
    }
    frames[i] = {
      timestamp, rosterIdx,
      posX: r.f32(), posY: r.f32(), posZ: r.f32(),
      velX: r.f32(), velY: r.f32(), velZ: r.f32(),
      yaw: r.f32(), pitch: r.f32(),
      flags: r.u8(),
    };
  }
  return frames;
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


// v5 trailer: tagged optional sections after remoteFrames. Unknown tags
// are skipped so newer sections don't break older readers of this file.
function readTrailerSections(r: Reader): { hmap?: DemoHeightmap; token?: ResultToken } {
  if (r.remaining === 0) {return {};}
  const count = r.u8();
  let hmap: DemoHeightmap | undefined = undefined;
  let token: ResultToken | undefined = undefined;
  for (let i = 0; i < count; i += 1) {
    r.ensure(1 + 4, 'trailer section header');
    const tag = r.u8();
    const len = r.u32();
    if (tag === SECTION_TOKEN) {token = JSON.parse(new TextDecoder().decode(r.bytes(len))) as ResultToken; continue;}
    if (tag !== SECTION_HMAP) {r.skip(len); continue;}
    const before = r.remaining;
    const gridN = r.u16();
    const heightScale = r.f32();
    const worldScale = r.f32();
    const srcHash = r.u32();
    const dataLen = r.u32();
    if (dataLen !== gridN * gridN) {
      throw new Error(`HMAP grid ${gridN}x${gridN} != ${dataLen} bytes`);
    }
    const data = r.bytes(dataLen);
    hmap = { gridN, heightScale, worldScale, srcHash, data: data.slice() };
    // Skip any padding a future writer adds inside the declared length.
    const consumed = before - r.remaining;
    if (consumed > len) {throw new Error('HMAP section overruns its length');}
    r.skip(len - consumed);
  }
  return { hmap, token };
}

export function deserializeDemo(buffer: ArrayBuffer): DemoFile {

    const r = new Reader(buffer);
    const header = readDemoHeader(r, buffer);
    const frames = readFrames(r, header.formatVersion >= 4);
    const projectileEvents = readProjectileEvents(r, header.formatVersion >= 6);
    const targetEvents = readTargetEvents(r);
    const roster = header.formatVersion >= 3 ? readRoster(r) : [];
    const remoteFrames = header.formatVersion >= 3 ? readRemoteFrames(r, roster.length) : [];
    const trailer = header.formatVersion >= 5 ? readTrailerSections(r) : {};
    validateHeaderCounts(header, frames, projectileEvents, targetEvents);
    return Object.assign({}, {header,frames,projectileEvents,targetEvents,roster,remoteFrames},
      (trailer.hmap ? { heightmap: trailer.hmap } : {}), (trailer.token ? { matchToken: trailer.token } : {}));
  }
