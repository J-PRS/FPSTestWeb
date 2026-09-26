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

const MAGIC = 0x54; // 'T'

export const WIRE_POSITION = 0x01;
export const WIRE_TICK = 0x02;

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
}

export function isWireFrame(u8: Uint8Array): boolean {
  return u8.length >= 2 && u8[0] === MAGIC;
}

// ---- C→S position ----

export function encodePosition(pos: WireVec3, rot: WireRot, vel: WireVec3, seq: number, ping: number): Uint8Array {
  const buf = new ArrayBuffer(30);
  const d = new DataView(buf);
  let o = 0;
  d.setUint8(o++, MAGIC);
  d.setUint8(o++, WIRE_POSITION);
  d.setUint32(o, seq >>> 0, true); o += 4;
  d.setFloat32(o, pos.x, true); o += 4;
  d.setFloat32(o, pos.y, true); o += 4;
  d.setFloat32(o, pos.z, true); o += 4;
  d.setInt16(o, Math.round(vel.x * 10), true); o += 2;
  d.setInt16(o, Math.round(vel.y * 10), true); o += 2;
  d.setInt16(o, Math.round(vel.z * 10), true); o += 2;
  d.setUint16(o, Math.round(((rot.yaw % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)) * (65535 / (Math.PI * 2))), true); o += 2;
  d.setInt16(o, Math.round(Math.max(-Math.PI, Math.min(Math.PI, rot.pitch)) * (32767 / Math.PI)), true); o += 2;
  d.setUint16(o, Math.min(65535, Math.max(0, Math.round(ping))), true); o += 2;
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
  const vx = d.getInt16(o, true) / 10; o += 2;
  const vy = d.getInt16(o, true) / 10; o += 2;
  const vz = d.getInt16(o, true) / 10; o += 2;
  const yaw = d.getUint16(o, true) * ((Math.PI * 2) / 65535); o += 2;
  const pitch = d.getInt16(o, true) * (Math.PI / 32767); o += 2;
  const ping = d.getUint16(o, true);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) ||
      !Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) return null;
  return {
    type: 'position',
    position: { x: px, y: py, z: pz },
    rotation: { yaw, pitch },
    velocity: { x: vx, y: vy, z: vz },
    seq,
    ping,
  };
}

// ---- S→C tickUpdate ----

/** Pre-encode one player's record — done ONCE per tick, shared across recipients. */
export function encodeTickPlayer(p: WireTickPlayer): Uint8Array {
  const id = ENC.encode(p.playerId);
  const buf = new ArrayBuffer(1 + id.length + 12 + 6 + 2 + 2 + 1 + 1 + 1);
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  let o = 0;
  u8[o++] = id.length;
  u8.set(id, o); o += id.length;
  d.setFloat32(o, p.position.x, true); o += 4;
  d.setFloat32(o, p.position.y, true); o += 4;
  d.setFloat32(o, p.position.z, true); o += 4;
  d.setInt16(o, Math.round(p.velocity.x * 10), true); o += 2;
  d.setInt16(o, Math.round(p.velocity.y * 10), true); o += 2;
  d.setInt16(o, Math.round(p.velocity.z * 10), true); o += 2;
  d.setUint16(o, Math.round(((p.rotation.yaw % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)) * (65535 / (Math.PI * 2))), true); o += 2;
  d.setInt16(o, Math.round(Math.max(-Math.PI, Math.min(Math.PI, p.rotation.pitch)) * (32767 / Math.PI)), true); o += 2;
  u8[o++] = Math.max(0, Math.min(255, Math.round(p.health)));
  u8[o++] = p.ping !== undefined ? Math.max(0, Math.min(255, Math.round(p.ping))) : 0;
  u8[o++] = (p.isDead ? 1 : 0) | (p.ski ? 2 : 0);
  return new Uint8Array(buf, 0, o);
}

/** Header + concatenated player records. ackSeq is per-recipient. */
export function encodeTickFrame(ackSeq: number, records: Uint8Array[]): Uint8Array {
  let total = 7;
  for (const r of records) total += r.length;
  const buf = new ArrayBuffer(total);
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  u8[0] = MAGIC;
  u8[1] = WIRE_TICK;
  d.setUint32(2, ackSeq >>> 0, true);
  u8[6] = records.length;
  let o = 7;
  for (const r of records) {
    u8.set(r, o);
    o += r.length;
  }
  return u8;
}

export function decodeTickFrame(u8: Uint8Array): { ackSeq: number; updates: WireTickPlayer[] } | null {
  if (u8.length < 7 || u8[0] !== MAGIC || u8[1] !== WIRE_TICK) return null;
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ackSeq = d.getUint32(2, true);
  const count = u8[6]!;
  const updates: WireTickPlayer[] = [];
  let o = 7;
  for (let i = 0; i < count; i++) {
    if (o >= u8.length) return null;
    const idLen = u8[o++]!;
    if (o + idLen + 22 > u8.length) return null;
    const playerId = DEC.decode(u8.subarray(o, o + idLen)); o += idLen;
    const px = d.getFloat32(o, true); o += 4;
    const py = d.getFloat32(o, true); o += 4;
    const pz = d.getFloat32(o, true); o += 4;
    const vx = d.getInt16(o, true) / 10; o += 2;
    const vy = d.getInt16(o, true) / 10; o += 2;
    const vz = d.getInt16(o, true) / 10; o += 2;
    const yaw = d.getUint16(o, true) * ((Math.PI * 2) / 65535); o += 2;
    const pitch = d.getInt16(o, true) * (Math.PI / 32767); o += 2;
    const health = u8[o++]!;
    const pingRaw = u8[o++]!;
    const flags = u8[o++]!;
    updates.push({
      playerId,
      position: { x: px, y: py, z: pz },
      rotation: { yaw, pitch },
      velocity: { x: vx, y: vy, z: vz },
      health,
      isDead: (flags & 1) !== 0,
      ping: pingRaw > 0 ? pingRaw : undefined,
      ski: (flags & 2) !== 0 ? 1 : 0,
    });
  }
  return { ackSeq, updates };
}
