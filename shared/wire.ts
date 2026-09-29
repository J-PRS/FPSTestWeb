/**
 * Binary wire codec for the hot path (position up, tickUpdate down).
 *
 * Frame = [MAGIC][type][payload]. JSON remains for rare/reliable events
 * (join, hits, knockback, stateHash) — only the ~20Hz streams go binary.
 *
 * position:  28B  (vs ~140B JSON)
 * tickUpdate: 7B header + ~39B/player (vs ~150B/player JSON)
 *
 * Quantization: velocity i16 @0.1 m/s (max ±3276), yaw u16 over [0,2π),
 * pitch i16 over [-π,π], health/ping u8. Sub-cm/sub-degree precision —
 * far below interp error.
 */

import { STATUS_MASK } from './status.js';

const MAGIC = 0x54; // 'T'

export const WIRE_POSITION = 0x01;
export const WIRE_TICK = 0x02;
export const WIRE_BALLSEG = 0x03;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export interface WireVec3 { x: number; y: number; z: number }
export interface WireRot { yaw: number; pitch: number }

export interface WirePosition {
  type: 'position';
  position: WireVec3;
  rotation: WireRot;
  velocity: WireVec3;
  seq: number;
  /** Last inputMove seq the client consumed — anchors the server's
   *  divergence probe so in-flight inputs don't read as drift. Absent
   *  on old 30-byte frames. */
  inputSeq?: number;
  ping: number;
}

export interface WireTickPlayer {
  playerId: string;
  position: WireVec3;
  rotation: WireRot;
  velocity: WireVec3;
  health: number;
  isDead: boolean;
  ping?: number;
  ski: number;
  /** Status bitmask (STATUS_* bits from status.ts) — bits 4+. */
  status?: number;
  /** Sheep meter 0-100, bots only — how pedestrian the server thinks
   *  this bot is. Trailing byte; absent on older records. */
  sheep?: number;
}

export function isWireFrame(u8: Uint8Array): boolean {
  return u8.length >= 2 && u8[0] === MAGIC;
}

// Quantizers — shared by both encoders so position and tick records can
// never drift out of sync (each would silently decode differently).
function packVel(d: DataView, o: number, v: WireVec3): number {
  d.setInt16(o, Math.round(v.x * 10), true); o += 2;
  d.setInt16(o, Math.round(v.y * 10), true); o += 2;
  d.setInt16(o, Math.round(v.z * 10), true); o += 2;
  return o;
}
function unpackVel(d: DataView, o: number, out: WireVec3): number {
  out.x = d.getInt16(o, true) / 10; o += 2;
  out.y = d.getInt16(o, true) / 10; o += 2;
  out.z = d.getInt16(o, true) / 10; o += 2;
  return o;
}
function packRot(d: DataView, o: number, rot: WireRot): number {
  const yaw2pi = ((rot.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  d.setUint16(o, Math.round(yaw2pi * (65535 / (Math.PI * 2))), true); o += 2;
  d.setInt16(o, Math.round(Math.max(-Math.PI, Math.min(Math.PI, rot.pitch)) * (32767 / Math.PI)), true); o += 2;
  return o;
}
function unpackRot(d: DataView, o: number, out: WireRot): number {
  out.yaw = d.getUint16(o, true) * ((Math.PI * 2) / 65535); o += 2;
  out.pitch = d.getInt16(o, true) * (Math.PI / 32767); o += 2;
  return o;
}

// ---- C→S position ----

export function encodePosition(pos: WireVec3, rot: WireRot, vel: WireVec3, seq: number, ping: number, inputSeq?: number): Uint8Array {
  const buf = new ArrayBuffer(34);
  const d = new DataView(buf);
  let o = 0;
  d.setUint8(o++, MAGIC);
  d.setUint8(o++, WIRE_POSITION);
  d.setUint32(o, seq >>> 0, true); o += 4;
  d.setFloat32(o, pos.x, true); o += 4;
  d.setFloat32(o, pos.y, true); o += 4;
  d.setFloat32(o, pos.z, true); o += 4;
  o = packVel(d, o, vel);
  o = packRot(d, o, rot);
  d.setUint16(o, Math.min(65535, Math.max(0, Math.round(ping))), true); o += 2;
  // Trailing inputSeq is optional — old 30-byte frames still decode.
  if (inputSeq !== undefined) { d.setUint32(o, inputSeq >>> 0, true); o += 4; }
  return new Uint8Array(buf, 0, o);
}

export function decodePosition(u8: Uint8Array): WirePosition | null {
  if (u8.length < 30 || u8[0] !== MAGIC || u8[1] !== WIRE_POSITION) return null;
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 2;
  const seq = d.getUint32(o, true); o += 4;
  const px = d.getFloat32(o, true); o += 4;
  const py = d.getFloat32(o, true); o += 4;
  const pz = d.getFloat32(o, true); o += 4;
  const velocity: WireVec3 = { x: 0, y: 0, z: 0 };
  o = unpackVel(d, o, velocity);
  const rotation: WireRot = { yaw: 0, pitch: 0 };
  o = unpackRot(d, o, rotation);
  const ping = d.getUint16(o, true); o += 2;
  const inputSeq = u8.length >= 34 ? d.getUint32(o, true) : undefined;
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) ||
      !Number.isFinite(velocity.x) || !Number.isFinite(velocity.y) || !Number.isFinite(velocity.z)) return null;
  // Same bound as the JSON validator's validateBody — position is
  // judge-mode truth, so an absurd claim would become broadcast state.
  if (px * px + py * py + pz * pz > 8192 * 8192) return null;
  return {
    type: 'position',
    position: { x: px, y: py, z: pz },
    rotation,
    velocity,
    seq,
    inputSeq,
    ping,
  };
}

// ---- S→C tickUpdate ----

/** Pre-encode one player's record — done ONCE per tick, shared across recipients. */
export function encodeTickPlayer(p: WireTickPlayer): Uint8Array {
  const id = ENC.encode(p.playerId);
  const buf = new ArrayBuffer(1 + id.length + 12 + 6 + 2 + 2 + 1 + 1 + 1 + 1);
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  let o = 0;
  u8[o++] = id.length;
  u8.set(id, o); o += id.length;
  d.setFloat32(o, p.position.x, true); o += 4;
  d.setFloat32(o, p.position.y, true); o += 4;
  d.setFloat32(o, p.position.z, true); o += 4;
  o = packVel(d, o, p.velocity);
  o = packRot(d, o, p.rotation);
  u8[o++] = Math.max(0, Math.min(255, Math.round(p.health)));
  u8[o++] = p.ping !== undefined ? Math.max(0, Math.min(255, Math.round(p.ping))) : 0;
  u8[o++] = (p.isDead ? 1 : 0) | (p.ski ? 2 : 0) | ((p.status ?? 0) & STATUS_MASK);
  // Always present — records are concatenated without lengths, so an
  // optional trailing byte would alias as the next record's idLen.
  u8[o++] = Math.max(0, Math.min(100, Math.round(p.sheep ?? 0)));
  return new Uint8Array(buf, 0, o);
}

/** Header + concatenated player records. ackSeq is per-recipient (echo of
 *  the client's last-received pos seq); tickSeq is the SERVER's frame seq —
 *  under an unordered transport receivers drop tickSeq <= lastTickSeq. */
export function encodeTickFrame(ackSeq: number, tickSeq: number, records: Uint8Array[]): Uint8Array {
  let total = 11;
  for (const r of records) total += r.length;
  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  u8[0] = MAGIC;
  u8[1] = WIRE_TICK;
  d.setUint32(2, ackSeq >>> 0, true);
  d.setUint32(6, tickSeq >>> 0, true);
  u8[10] = records.length;
  let o = 11;
  for (const r of records) {
    u8.set(r, o);
    o += r.length;
  }
  return u8;
}

export function decodeTickFrame(u8: Uint8Array): { ackSeq: number; tickSeq: number; updates: WireTickPlayer[] } | null {
  if (u8.length < 11 || u8[0] !== MAGIC || u8[1] !== WIRE_TICK) return null;
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ackSeq = d.getUint32(2, true);
  const tickSeq = d.getUint32(6, true);
  const count = u8[10]!;
  const updates: WireTickPlayer[] = [];
  let o = 11;
  for (let i = 0; i < count; i++) {
    if (o >= u8.length) return null;
    const idLen = u8[o++]!;
    if (o + idLen + 25 > u8.length) return null;
    const playerId = DEC.decode(u8.subarray(o, o + idLen)); o += idLen;
    const px = d.getFloat32(o, true); o += 4;
    const py = d.getFloat32(o, true); o += 4;
    const pz = d.getFloat32(o, true); o += 4;
    const vel: WireVec3 = { x: 0, y: 0, z: 0 };
    o = unpackVel(d, o, vel);
    const rot: WireRot = { yaw: 0, pitch: 0 };
    o = unpackRot(d, o, rot);
    const health = u8[o++]!;
    const pingRaw = u8[o++]!;
    const flags = u8[o++]!;
    const sheep = u8[o++]!;
    updates.push({
      playerId,
      position: { x: px, y: py, z: pz },
      rotation: rot,
      velocity: vel,
      health,
      isDead: (flags & 1) !== 0,
      ping: pingRaw > 0 ? pingRaw : undefined,
      ski: (flags & 2) !== 0 ? 1 : 0,
      status: flags & STATUS_MASK,
      sheep: sheep > 0 ? sheep : undefined,
    });
  }
  return { ackSeq, tickSeq, updates };
}

// ---- S→C ballSegment (highest-rate event: every bounce/heartbeat) ----

const SEG_KINDS = ['bounce', 'lunge', 'enrage', 'stall', 'teleport', 'spawn', 'knockback', 'hit'] as const;
const segKindIdx = new Map<string, number>(SEG_KINDS.map((k, i) => [k, i]));

export interface WireBallSegment {
  id: number;
  kind: string;
  position: WireVec3;
  velocity: WireVec3;
  enraged: boolean;
  targetId: string | null;
  tp: WireVec3 | null;
  et: number;     // enrageTimer, seconds
  slowT: number;  // stall timer, seconds
  damp: boolean;  // dampNextBounce
  t: number;      // server sim time
}

/** ~46B fixed + optional fields vs ~140B+ JSON. */
export function encodeBallSegment(s: WireBallSegment): Uint8Array {
  const idBytes = s.targetId !== null ? ENC.encode(s.targetId) : null;
  const buf = new ArrayBuffer(56 + (idBytes ? 1 + idBytes.length : 0));
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  let o = 0;
  d.setUint8(o++, MAGIC);
  d.setUint8(o++, WIRE_BALLSEG);
  d.setUint32(o, s.id >>> 0, true); o += 4;
  d.setUint8(o++, segKindIdx.get(s.kind) ?? 0);
  d.setFloat32(o, s.t, true); o += 4;
  d.setFloat32(o, s.position.x, true); o += 4;
  d.setFloat32(o, s.position.y, true); o += 4;
  d.setFloat32(o, s.position.z, true); o += 4;
  d.setFloat32(o, s.velocity.x, true); o += 4;
  d.setFloat32(o, s.velocity.y, true); o += 4;
  d.setFloat32(o, s.velocity.z, true); o += 4;
  d.setUint8(o++,
    (s.enraged ? 1 : 0) | (s.damp ? 2 : 0) | (s.tp ? 4 : 0) | (idBytes ? 8 : 0));
  // Float32, not tenths: the client replays the pull with these timers and
  // ±0.05s of quantization error compounds into meters of divergence at
  // bounces — the last mid-leg mismatch after grid-locking.
  d.setFloat32(o, s.et, true); o += 4;
  d.setFloat32(o, s.slowT, true); o += 4;
  if (s.tp) {
    d.setFloat32(o, s.tp.x, true); o += 4;
    d.setFloat32(o, s.tp.y, true); o += 4;
    d.setFloat32(o, s.tp.z, true); o += 4;
  }
  if (idBytes) {
    d.setUint8(o++, idBytes.length);
    u8.set(idBytes, o); o += idBytes.length;
  }
  return new Uint8Array(buf, 0, o);
}

export function decodeBallSegment(u8: Uint8Array): WireBallSegment | null {
  if (u8.length < 44 || u8[0] !== MAGIC || u8[1] !== WIRE_BALLSEG) return null;
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 2;
  const id = d.getUint32(o, true); o += 4;
  const kind = SEG_KINDS[d.getUint8(o++)] ?? 'bounce';
  const t = d.getFloat32(o, true); o += 4;
  const position = { x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true) }; o += 12;
  const velocity = { x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true) }; o += 12;
  const flags = d.getUint8(o++);
  const et = d.getFloat32(o, true); o += 4;
  const slowT = d.getFloat32(o, true); o += 4;
  let tp: WireVec3 | null = null;
  if (flags & 4) {
    tp = { x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true) }; o += 12;
  }
  let targetId: string | null = null;
  if (flags & 8) {
    const idLen = d.getUint8(o++);
    if (o + idLen > u8.length) return null;
    targetId = DEC.decode(u8.subarray(o, o + idLen));
  }
  return {
    id, kind, position, velocity,
    enraged: (flags & 1) !== 0,
    damp: (flags & 2) !== 0,
    targetId, tp, et, slowT, t,
  };
}
