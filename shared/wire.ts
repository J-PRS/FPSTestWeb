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
 * pitch i16 over [-π,π], health u16, ping u8. Sub-cm/sub-degree precision —
 * far below interp error.
 */

import { STATUS_MASK } from './status.js';

const snap = (): V4Snap => ({ wireId: -1, velX: 0, velY: 0, velZ: 0, yaw: 0, pitch: 0, hp: -1, flags: -1, sheepJet: -1 });


const MAGIC = 0x54; // 'T'

export const WIRE_POSITION = 0x01;
export const WIRE_INPUTMOVE = 0x08;
export const WIRE_JSON = 0x09; // raw JSON bytes riding the binary lane
export const WIRE_TICK = 0x04; // v2: positions are i16-quantized (POS_Q)
export const WIRE_TICK_V1 = 0x02; // legacy f32 positions — decode-only,
// v3: record identity is a room-scoped u16 instead of an id string
// (~9B saved per record at typical bot-name lengths). The id->playerId
// roster arrives on the reliable JSON lane ('wireIds') before any frame
// can reference it — same-socket ordering makes the dance free.
export const WIRE_TICK_V3 = 0x06;
/** v4 = v3 records + per-field delta mask. Masked groups inherit the
 *  receiver's last-decoded value for that wireId; encode-side compares
 *  against last-ENCODED (not last-delivered) values, so a lost frame
 *  degrades to the staleness loss already tolerated, and periodic full
 *  records bound it. */
export const WIRE_TICK_V4 = 0x07;
                                // keeps recorded .rec captures playing
export const WIRE_BALLSEG = 0x03;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export interface WireVec3 { x: number; y: number; z: number }
export interface WireRot { yaw: number; pitch: number }

/** NaN/Inf in a decoded vector poisons whatever sim consumes it —
 *  one guard every wire-consumer funnel calls before trusting xyz. */
export function finiteVec(v: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

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
  /** Held input state riding the volatile frame — the datagram-lane
   *  answer to inputMove: a superseding stream where a lost packet
   *  costs nothing because the next frame carries the same state.
   *  Trailing fields; absent on frames <37 bytes. */
  input?: { forward: number; right: number; jump: number; ski: number; jet: number };
  ping: number;
}

export interface WireTickPlayer {
  playerId: string;
  /** v3 numeric id — set on decode, 0 on v1/v2 frames. */
  wireId?: number;
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
  /** Held jet input (0/1) — rides sheep's bit 7 (sheep caps at 100, so
   *  the high bit was dead space) at zero bytes-per-record cost. Remote
   *  dead-reckon burns thrust on it; absent on older frames. */
  jet?: number;
}

export function isWireFrame(u8: Uint8Array): boolean {
  return u8.length >= 2 && u8[0] === MAGIC;
}

// Quantizers — shared by both encoders so position and tick records can
// never drift out of sync (each would silently decode differently).
function packVel(d: DataView, o: number, v: WireVec3): number {
  let off = o;
  d.setInt16(off, Math.round(v.x * 10), true); off += 2;
  d.setInt16(off, Math.round(v.y * 10), true); off += 2;
  d.setInt16(off, Math.round(v.z * 10), true); off += 2;
  return off;
}
function unpackVel(d: DataView, o: number, out: WireVec3): number {
  let off = o;
  out.x = d.getInt16(off, true) / 10; off += 2;
  out.y = d.getInt16(off, true) / 10; off += 2;
  out.z = d.getInt16(off, true) / 10; off += 2;
  return off;
}
function packRot(d: DataView, o: number, rot: WireRot): number {
  let off = o;
  const yaw2pi = ((rot.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  d.setUint16(off, Math.round(yaw2pi * (65_535 / (Math.PI * 2))), true); off += 2;
  d.setInt16(off, Math.round(Math.max(-Math.PI, Math.min(Math.PI, rot.pitch)) * (32_767 / Math.PI)), true); off += 2;
  return off;
}
function unpackRot(d: DataView, o: number, out: WireRot): number {
  let off = o;
  out.yaw = d.getUint16(off, true) * ((Math.PI * 2) / 65_535); off += 2;
  out.pitch = d.getInt16(off, true) * (Math.PI / 32_767); off += 2;
  return off;
}

// ---- C→S position ----

export function encodePosition(pos: WireVec3, rot: WireRot, vel: WireVec3, seq: number, ping: number, inputSeq?: number, input?: { forward: number; right: number; jump: number; ski: number; jet: number }): Uint8Array {
  const buf = new ArrayBuffer(37);
  const d = new DataView(buf);
  let o = 0;
  d.setUint8(((o += 1) - 1), MAGIC);
  d.setUint8(((o += 1) - 1), WIRE_POSITION);
  d.setUint32(o, seq >>> 0, true); o += 4;
  d.setFloat32(o, pos.x, true); o += 4;
  d.setFloat32(o, pos.y, true); o += 4;
  d.setFloat32(o, pos.z, true); o += 4;
  o = packVel(d, o, vel);
  o = packRot(d, o, rot);
  d.setUint16(o, Math.min(65_535, Math.max(0, Math.round(ping))), true); o += 2;
  // Trailing inputSeq is optional — old 30-byte frames still decode.
  if (inputSeq !== undefined) { d.setUint32(o, inputSeq >>> 0, true); o += 4; }
  // Held input as a superseding stream: +3B, seq'd by inputSeq — the
  // seq gate drops stale applies, a dropped frame costs nothing.
  if (input !== undefined) {
    d.setInt8(((o += 1) - 1), Math.round(input.forward));
    d.setInt8(((o += 1) - 1), Math.round(input.right));
    d.setUint8(((o += 1) - 1), (input.jump ? 1 : 0) | (input.ski ? 2 : 0) | (input.jet ? 4 : 0));
  }
  return new Uint8Array(buf, 0, o);
}

/** Reusable decode target — position reports are the hottest inbound
 *  message (~30Hz per player × every player), ~4 fresh objects each.
 *  All consumers copy field-wise inside the handler, so a per-socket
 *  slot is safe: the returned object aliases `into` until the next call. */
export function decodePosition(u8: Uint8Array, into?: WirePosition): WirePosition | null {
  if (u8.length < 30 || u8[0] !== MAGIC || u8[1] !== WIRE_POSITION) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 2;
  const seq = d.getUint32(o, true); o += 4;
  const px = d.getFloat32(o, true); o += 4;
  const py = d.getFloat32(o, true); o += 4;
  const pz = d.getFloat32(o, true); o += 4;
  const msg = into ?? {
    type: 'position',
    position: { x: 0, y: 0, z: 0 },
    rotation: { yaw: 0, pitch: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    seq: 0, ping: 0,
  } as WirePosition;
  o = unpackVel(d, o, msg.velocity);
  o = unpackRot(d, o, msg.rotation);
  const ping = d.getUint16(o, true); o += 2;
  msg.inputSeq = u8.length >= 34 ? d.getUint32(o, true) : undefined;
  o += u8.length >= 34 ? 4 : 0;
  if (u8.length >= 37) {
    // The input slot recycles too — a frame shorter than 37 must not
    // inherit a prior message's held bits.
    if (!msg.input) {msg.input = { forward: 0, right: 0, jump: 0, ski: 0, jet: 0 } as NonNullable<WirePosition['input']>;}
    msg.input.forward = d.getInt8(o); msg.input.right = d.getInt8(o + 1);
    msg.input.jump = (d.getUint8(o + 2) & 1) ? 1 : 0; msg.input.ski = (d.getUint8(o + 2) & 2) ? 1 : 0; msg.input.jet = (d.getUint8(o + 2) & 4) ? 1 : 0;
  } else {
    msg.input = undefined;
  }
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) ||
      !Number.isFinite(msg.velocity.x) || !Number.isFinite(msg.velocity.y) || !Number.isFinite(msg.velocity.z)) {return null;}
  // Same bounds as the JSON validator's validateBody — the binary lane
  // must refuse what the JSON lane refuses, and position is judge-mode
  // truth, so an absurd claim would become broadcast state.
  if (px * px + py * py + pz * pz > 8192 * 8192) {return null;}
  if (msg.velocity.x * msg.velocity.x + msg.velocity.y * msg.velocity.y + msg.velocity.z * msg.velocity.z > 1000 * 1000) {return null;}
  msg.position.x = px; msg.position.y = py; msg.position.z = pz;
  msg.seq = seq;
  msg.ping = ping;
  return msg;
}

// ---- C→S inputMove (binary) ----
// The edge-timed input journal's fast lane: same semantic as the JSON
// inputMove (edge + prev redundancy), minus the rotation the server
// never reads (yaw comes from position reports). Layout:
//   seq u32 | fwd i8 | right i8 | flags u8 | status u8 | ageMs u16
//   | hasPrev u8
//   [pseq u32 | pfwd i8 | pright i8 | pflags u8 | pstatus u8 | pageMs u16]
// ageMs = ms before send the edge fired - the sub-tick stamp the drain
// slices the tick window by. Legacy frames (8B edges, no age) still
// decode; their edges just carry no stamp.
export interface WireInputMove {
  type: 'inputMove';
  seq?: number;
  ageMs?: number;
  input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number };
  rotation: { yaw: number; pitch: number };
  prev?: { seq?: number; ageMs?: number; input: NonNullable<WireInputMove['input']>; rotation: { yaw: number; pitch: number } };
}

export interface InputEdge { seq?: number; ageMs?: number; input: NonNullable<WireInputMove['input']>; rotation: { yaw: number; pitch: number } }

function writeInputEdge(d: DataView, o: number, e: InputEdge): number {
  d.setUint32(o, (e.seq ?? 0) >>> 0, true);
  d.setInt8(o + 4, Math.round(e.input.forward));
  d.setInt8(o + 5, Math.round(e.input.right));
  d.setUint8(o + 6, (e.input.jump ? 1 : 0) | (e.input.ski ? 2 : 0) | (e.input.jet ? 4 : 0));
  d.setUint8(o + 7, (e.input.status ?? 0) & 0xFF);
  d.setUint16(o + 8, Math.min(Math.max(Math.round(e.ageMs ?? 0), 0), 0xFF_FF), true);
  return o + 10;
}

export function encodeInputMove(seq: number, input: NonNullable<WireInputMove['input']>, prev?: InputEdge, curAgeMs = 0): Uint8Array {
  const buf = new ArrayBuffer(prev ? 23 : 13);
  const d = new DataView(buf);
  d.setUint8(0, MAGIC);
  d.setUint8(1, WIRE_INPUTMOVE);
  const end = writeInputEdge(d, 2, { seq, ageMs: curAgeMs, input, rotation: { yaw: 0, pitch: 0 } });
  if (prev) {
    d.setUint8(end, 1);
    writeInputEdge(d, end + 1, prev);
  } else {
    d.setUint8(end, 0);
  }
  return new Uint8Array(buf);
}

function readInputEdge(d: DataView, o: number, stamped: boolean): InputEdge | null {
  const stride = stamped ? 10 : 8;
  if (d.byteLength < o + stride) {return null;}
  const seq = d.getUint32(o, true);
  const forward = d.getInt8(o + 4), right = d.getInt8(o + 5);
  const flags = d.getUint8(o + 6);
  const status = d.getUint8(o + 7);
  const e: InputEdge = { seq, rotation: { yaw: 0, pitch: 0 },
    input: { forward, right, jump: (flags & 1) ? 1 : 0, ski: (flags & 2) ? 1 : 0, jet: (flags & 4) ? 1 : 0, status } };
  if (stamped) {e.ageMs = d.getUint16(o + 8, true);}
  return e;
}

export function decodeInputMove(u8: Uint8Array): WireInputMove | null {
  if (u8.length < 11 || u8[0] !== MAGIC || u8[1] !== WIRE_INPUTMOVE) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Frame shapes: stamped 13/23 bytes, legacy 11/19 - anything else is
  // not a well-formed inputMove.
  const stamped = u8.length === 13 || u8.length === 23;
  if (!stamped && u8.length !== 11 && u8.length !== 19) {return null;}
  const cur = readInputEdge(d, 2, stamped);
  if (!cur || !Number.isFinite(cur.input.forward + cur.input.right)) {return null;}
  const msg: WireInputMove = { type: 'inputMove', seq: cur.seq, ageMs: cur.ageMs, input: cur.input, rotation: { yaw: 0, pitch: 0 } };
  const prevAt = stamped ? 13 : 11;
  const flagAt = stamped ? 12 : 10;
  if (u8.length > prevAt && d.getUint8(flagAt) === 1) {
    const prev = readInputEdge(d, prevAt, stamped);
    if (prev) {msg.prev = prev;}
  }
  return msg;
}

// ---- C→S JSON-over-binary ----
// Any ClientMessage can ride the fast binary lane as framed JSON: combat
// claims (shotFired/aoeShot/deploy/…) get the position lane's transit
// instead of the JSON stream's — same validation, same ordering within
// the lane, ~50ms earlier arrival on WT. Decode returns the JSON text;
// the caller runs the normal parse+validate path on it.
export function encodeWireJson(text: string): Uint8Array {
  const bytes = ENC.encode(text);
  const out = new Uint8Array(2 + bytes.length);
  out[0] = MAGIC;
  out[1] = WIRE_JSON;
  out.set(bytes, 2);
  return out;
}

export function decodeWireJson(u8: Uint8Array): string | null {
  if (u8.length < 3 || u8[0] !== MAGIC || u8[1] !== WIRE_JSON) {return null;}
  try { return DEC.decode(u8.subarray(2)); }
  catch { return null; }
}

// ---- S→C tickUpdate ----

// Position quantization for tick records: i32 × 0.04m at 4cm steps —
// sub-pixel on screen and self is never in the record set, so nothing
// reconciles against it. i16×0.04 saturated at ±1310m: skiers past that
// edge CLAMPED on the wire and read as parked at 1310.7 while the sim
// kept moving (the dunes z-freeze desync). i32 keeps the same precision
// with ±85Mm of range the world can't outgrow — the clamp below is now
// dead-capacity safety, not a reachable bound.
const POS_Q = 0.04;
const packPos = (d: DataView, o: number, x: number, y: number, z: number): number => {
  let off = o;
  d.setInt32(off, Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(x / POS_Q))), true); off += 4;
  d.setInt32(off, Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(y / POS_Q))), true); off += 4;
  d.setInt32(off, Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(z / POS_Q))), true); off += 4;
  return off;
};

/** Pre-encode one player's record — done ONCE per tick, shared across recipients. */
export function encodeTickPlayer(p: WireTickPlayer): Uint8Array {
  const id = ENC.encode(p.playerId);
  const buf = new ArrayBuffer(1 + id.length + 12 + 6 + 2 + 2 + 2 + 1 + 1 + 1);
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  let o = 0;
  u8[((o += 1) - 1)] = id.length;
  u8.set(id, o); o += id.length;
  o = packPos(d, o, p.position.x, p.position.y, p.position.z);
  o = packVel(d, o, p.velocity);
  o = packRot(d, o, p.rotation);
  // u8 clamped real hp at 255 — heavies/bots run 300+, which shipped as
  // 255 on the wire and desynced every StateHash check against truth.
  d.setUint16(o, Math.max(0, Math.min(65_535, Math.round(p.health))), true); o += 2;
  u8[((o += 1) - 1)] = p.ping === undefined ? 0 : Math.max(0, Math.min(255, Math.round(p.ping)));
  u8[((o += 1) - 1)] = (p.isDead ? 1 : 0) | (p.ski ? 2 : 0) | ((p.status ?? 0) & STATUS_MASK);
  // Always present — records are concatenated without lengths, so an
  // optional trailing byte would alias as the next record's idLen.
  u8[((o += 1) - 1)] = Math.max(0, Math.min(100, Math.round(p.sheep ?? 0))) | (p.jet ? 0x80 : 0);
  return new Uint8Array(buf, 0, o);
}

/** v3 record byte length — u16 wireId replaces the idLen+string prefix. */
export const TICK_PLAYER_V3_BYTES = 2 + 12 + 6 + 2 + 2 + 2 + 1 + 1 + 1;
/** Reusable encode target for hot paths (one per pooled record slot):
 *  the returned Uint8Array aliases `into.buf` until the next encode. */
export interface TickEncodeScratch { buf: ArrayBuffer; u8: Uint8Array; d: DataView }
export function tickEncodeScratch(): TickEncodeScratch {
  // Sized for the largest record any encoder writes — v4's mask byte
  // pushes a full record to 30B (one over v3's fixed 29).
  const buf = new ArrayBuffer(TICK_PLAYER_V3_BYTES + 1);
  return { buf, u8: new Uint8Array(buf), d: new DataView(buf) };
}

/** v3 record: u16 wireId replaces the idLen+string prefix (29B total). */
export function encodeTickPlayerV3(wireId: number, p: WireTickPlayer, into?: TickEncodeScratch): Uint8Array {
  const { buf, u8, d } = into ?? tickEncodeScratch();
  let o = 0;
  d.setUint16(o, wireId, true); o += 2;
  o = packPos(d, o, p.position.x, p.position.y, p.position.z);
  o = packVel(d, o, p.velocity);
  o = packRot(d, o, p.rotation);
  d.setUint16(o, Math.max(0, Math.min(65_535, Math.round(p.health))), true); o += 2;
  u8[((o += 1) - 1)] = p.ping === undefined ? 0 : Math.max(0, Math.min(255, Math.round(p.ping)));
  u8[((o += 1) - 1)] = (p.isDead ? 1 : 0) | (p.ski ? 2 : 0) | ((p.status ?? 0) & STATUS_MASK);
  u8[((o += 1) - 1)] = Math.max(0, Math.min(100, Math.round(p.sheep ?? 0))) | (p.jet ? 0x80 : 0);
  return new Uint8Array(buf, 0, o);
}

/** Header + concatenated player records. ackSeq is per-recipient (echo of
 *  the client's last-received pos seq); tickSeq is the SERVER's frame seq —
 *  under an unordered transport receivers drop tickSeq <= lastTickSeq.
 *  inputAck is the tick-set confirm (Quantum-style): the highest inputMove
 *  seq the server has consumed for this recipient — the client prunes its
 *  input journal against it and detects a starving command stream. */
/** Reusable frame target — the fanout builds every recipient's frame
 *  into ONE arena because each transport's send() consumes the bytes
 *  synchronously before the next recipient's encode overwrites them.
 *  Do NOT retain the returned view past the send call. */
export interface TickFrameScratch { buf: ArrayBuffer; u8: Uint8Array; d: DataView }
export function tickFrameScratch(cap = 2048): TickFrameScratch {
  const buf = new ArrayBuffer(cap);
  return { buf, u8: new Uint8Array(buf), d: new DataView(buf) };
}

export function encodeTickFrame(ackSeq: number, tickSeq: number, inputAck: number, records: Uint8Array[], type: number = WIRE_TICK, into?: TickFrameScratch): Uint8Array {
  let total = 15;
  for (const r of records) {total += r.length;}
  // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
  // oxlint-disable-next-line init-declarations -- assigned later
  let u8!: Uint8Array, d;
  if (into) {
    if (into.buf.byteLength < total) {
      // Grow to the next power-of-two above need — resize-once amortized.
      let cap = into.buf.byteLength;
      while (cap < total) {cap *= 2;}
      into.buf = new ArrayBuffer(cap);
      into.u8 = new Uint8Array(into.buf);
      into.d = new DataView(into.buf);
    }
    ({u8} = into); ({d} = into);
  } else {
    const buf = new ArrayBuffer(total);
    u8 = new Uint8Array(buf);
    d = new DataView(buf);
  }
  u8[0] = MAGIC;
  u8[1] = type;
  d.setUint32(2, ackSeq >>> 0, true);
  d.setUint32(6, tickSeq >>> 0, true);
  d.setUint32(10, inputAck >>> 0, true);
  u8[14] = records.length;
  let o = 15;
  for (const r of records) {
    u8.set(r, o);
    o += r.length;
  }
  // Scratch encodes hand back a view into the arena (cap-sized u8), not
  // a fresh exact-fit array — senders must consume it before the next call.
  return into ? u8.subarray(0, total) : u8;
}

/** Reusable decode pool — pass the SAME object every call and slot
 *  entries are mutated in place instead of allocating ~4 objects per
 *  player per frame. The returned `updates` view aliases the pool and
 *  is only valid until the next decode: consumers must copy any field
 *  they retain. */
export interface TickDecodePool {
  slots: WireTickPlayer[];
  /** v3/v4 frames resolve numeric ids through the room roster the 'wireIds'
   *  JSON events maintain; unresolved ids decode with playerId ''. */
  resolveId?: (wireId: number) => string | undefined;
  /** v4 masked fields inherit per-wireId state decoded here — the SAME
   *  slots the updates view hands out, so retention stays on the pool's
   *  "valid until next decode" contract. Cleared by WireIdRoster on a
   *  fresh gameState. */
  byId?: Map<number, WireTickPlayer>;
}

export function decodeTickFrame(u8: Uint8Array, pool?: TickDecodePool): { ackSeq: number; tickSeq: number; inputAck: number; updates: WireTickPlayer[]; count: number } | null {
  if (u8.length < 15 || u8[0] !== MAGIC ||
      (u8[1] !== WIRE_TICK && u8[1] !== WIRE_TICK_V1 && u8[1] !== WIRE_TICK_V3 && u8[1] !== WIRE_TICK_V4)) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ackSeq = d.getUint32(2, true);
  const tickSeq = d.getUint32(6, true);
  const inputAck = d.getUint32(10, true);
  const count = u8[14]!;
  const v1 = u8[1] === WIRE_TICK_V1;
  const v3 = u8[1] === WIRE_TICK_V3;
  const v4 = u8[1] === WIRE_TICK_V4;
  // Minimum guaranteed bytes after the id — covers the whole record
  // minus the optional sheep byte (v1 f32 pos: 12+6+4+2+1+1, v2 i32
  // pos: 12+6+4+2+1+1 — coincidentally both 26).
  const tail = 26;
  const slots = pool ? pool.slots : [];
  // v4 records decode into their retained baseline objects in place —
  // a frame that dies mid-way would leave half-applied state that later
  // deltas inherit. Track touched wireIds so a failure can evict them:
  // the corrupt frame degrades to a lost frame and heals on the next
  // full (~750ms) instead of poisoning every delta until then.
  const touched: number[] = [];
  const fail = (): null => {
    for (const id of touched) {pool?.byId?.delete(id);}
    return null;
  };
  let o = 15;
  for (let i = 0; i < count; i += 1) {
    if (o >= u8.length) {return fail();}
    // oxlint-disable-next-line init-declarations -- assigned later
    let playerId!: string;
    let wireId = 0;
    if (v3) {
      if (o + 29 > u8.length) {return fail();}
      wireId = d.getUint16(o, true); o += 2;
      playerId = pool?.resolveId?.(wireId) ?? '';
    } else if (v4) {
      // Variable-length record: bounds-check each present group as it
      // decodes — a truncated frame must die, not read past the buffer.
      if (o + 15 > u8.length) {return fail();}
      wireId = d.getUint16(o, true); o += 2;
      playerId = pool?.resolveId?.(wireId) ?? '';
    } else {
      const idLen = u8[((o += 1) - 1)]!;
      if (o + idLen + tail > u8.length) {return fail();}
      playerId = DEC.decode(u8.subarray(o, o + idLen)); o += idLen;
    }
    // v4 decodes into the per-wireId slot so masked groups inherit the
    // last-decoded values; flat slots stay for v1/v3 frames.
    // oxlint-disable-next-line init-declarations -- assigned later
    let u!: WireTickPlayer | undefined;
    let v4HadBase = false;
    if (v4) {
      touched.push(wireId); // any mutation below reaches the baseline
      u = pool?.byId?.get(wireId);
      v4HadBase = u !== undefined;
      if (!u) {u = { playerId, position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 0, isDead: false } as WireTickPlayer;}
      slots[i] = u;
    } else {
      u = slots[i] as WireTickPlayer | undefined;
      if (!u) {
        u = { playerId, position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 0, isDead: false } as WireTickPlayer;
        slots[i] = u;
      }
    }
    u.playerId = playerId;
    u.wireId = wireId;
    if (v4) {
      const mask = u8[((o += 1) - 1)]!;
      if (o + 12 > u8.length) {return fail();}
      u.position.x = d.getInt32(o, true) * POS_Q; o += 4;
      u.position.y = d.getInt32(o, true) * POS_Q; o += 4;
      u.position.z = d.getInt32(o, true) * POS_Q; o += 4;
      if (mask & V4_MASK_VEL) {
        if (o + 6 > u8.length) {return fail();}
        o = unpackVel(d, o, u.velocity);
      }
      if (mask & V4_MASK_ROT) {
        if (o + 4 > u8.length) {return fail();}
        o = unpackRot(d, o, u.rotation);
      }
      if (mask & V4_MASK_HP_PING) {
        if (o + 3 > u8.length) {return fail();}
        u.health = d.getUint16(o, true); o += 2;
        const pingRaw = u8[((o += 1) - 1)]!;
        u.ping = pingRaw > 0 ? pingRaw : undefined;
      }
      if (mask & V4_MASK_FLAGS_SHEEP) {
        if (o + 2 > u8.length) {return fail();}
        const flags = u8[((o += 1) - 1)]!;
        const sheep = u8[((o += 1) - 1)]!;
        u.isDead = (flags & 1) !== 0;
        u.ski = (flags & 2) === 0 ? 0 : 1;
        u.status = flags & STATUS_MASK;
        u.jet = (sheep & 0x80) === 0 ? 0 : 1;
        u.sheep = (sheep & 0x7F) > 0 ? sheep & 0x7F : undefined;
      }
      if (!v4HadBase && (mask & V4_MASK_FULL) !== V4_MASK_FULL) {
        // Mid-join window: a masked delta without a decode baseline is
        // undecodable — inherited fields would read as zeros until the
        // next forced-full (~750ms). Drop it like a lost frame via the
        // empty-id convention; the full record heals it.
        u.playerId = '';
        continue;
      }
      if (u.health === 0 && !u.isDead) {
        // Impossible state — the encoder's wire-row-coherent invariant
        // (isDead || health>0) means hp0+alive can ONLY be corruption:
        // misaligned bytes, a recycled baseline, a torn frame. Left alone
        // it persists FOREVER — hp is masked out of every delta until it
        // changes, so a phantom-dead ghost survives until the next full.
        // Drop the row AND the poisoned baseline: baseline-less deltas
        // self-drop above, and the next periodic full reseeds cleanly.
        pool?.byId?.delete(wireId);
        u.playerId = '';
        continue;
      }
      pool?.byId?.set(wireId, u);
      continue;
    }
    // oxlint-disable-next-line init-declarations -- assigned by branch below
    let px!: number, py!: number, pz!: number;
    if (v1) {
      px = d.getFloat32(o, true); o += 4;
      py = d.getFloat32(o, true); o += 4;
      pz = d.getFloat32(o, true); o += 4;
    } else {
      px = d.getInt32(o, true) * POS_Q; o += 4;
      py = d.getInt32(o, true) * POS_Q; o += 4;
      pz = d.getInt32(o, true) * POS_Q; o += 4;
    }
    u.position.x = px; u.position.y = py; u.position.z = pz;
    o = unpackVel(d, o, u.velocity);
    o = unpackRot(d, o, u.rotation);
    u.health = d.getUint16(o, true); o += 2;
    const pingRaw = u8[((o += 1) - 1)]!;
    const flags = u8[((o += 1) - 1)]!;
    const sheep = o < u8.length ? u8[((o += 1) - 1)]! : 0;
    u.isDead = (flags & 1) !== 0;
    u.ping = pingRaw > 0 ? pingRaw : undefined;
    u.ski = (flags & 2) === 0 ? 0 : 1;
    u.status = flags & STATUS_MASK;
    u.jet = (sheep & 0x80) === 0 ? 0 : 1;
    u.sheep = (sheep & 0x7F) > 0 ? sheep & 0x7F : undefined;
  }
  // No slice: the pooled slots array outlives the frame — consumers loop
  // to `count` so a fresh updates[] per 30Hz frame stops being an alloc.
  return { ackSeq, tickSeq, inputAck, updates: slots, count };
}

/** Receiver-side v3 roster: feed every JSON message through feed() and
 *  pass `pool` to decodeTickFrame — handles the gameState snapshot and
 *  'wireIds' deltas in one place (probes, netbot, replay tools). */
export class WireIdRoster {
  readonly ids = new Map<number, string>();
  readonly pool: TickDecodePool = { slots: [], byId: new Map(), resolveId: (id): string | undefined => this.ids.get(id) };
  feed(m: { type?: string; add?: Record<number, string>; wireIds?: Record<number, string> }): void {
    if (m.type === 'wireIds' && m.add) {
      for (const [id, pid] of Object.entries(m.add)) {
        const n = Number(id);
        // Re-seat without remove still retires the prior baseline.
        if (this.ids.has(n)) {this.pool.byId?.delete(n);}
        this.ids.set(n, pid);
      }
      // A retired id's decode baseline dies with it — a later reissue
      // must seat a fresh full record, never inherit the old owner's.
      for (const id of (m as { remove?: number[] }).remove ?? []) {this.pool.byId?.delete(Number(id));}
    } else if (m.type === 'gameState') {
      this.ids.clear();
      // Fresh epoch: masked deltas must not inherit fields a previous
      // room's wireId left decoded (a reassigned id would inherit stale
      // health/vel until its next change).
      this.pool.byId?.clear();
      if (m.wireIds) {for (const [id, pid] of Object.entries(m.wireIds)) {this.ids.set(Number(id), pid);}}
    }
  }
}

/** tickSeq → server time: frames run at CONFIG.tickRate (20Hz = 50ms).
 *  Snapshot timelines must be stamped with this, not packet-arrival
 *  wall time — arrival stamps fold transport jitter into the render
 *  position itself (the rubberband source). */
export const SERVER_TICK_MS = 50;
/** One sim quantum in seconds — server stepAll loops and client replays
 *  must agree or every edge/replay drifts one quantum per miss. */
export const SIM_TICK_DT = SERVER_TICK_MS / 1000;

/** Combat noise ring TTL — server `noises` and the client senses mirror
 *  must agree or offline bots hear less than online ones. */
export const NOISE_TTL_MS = 2000;

/** v4 record delta mask bits (position is unconditional — a record only
 *  exists when its carrier moved enough to matter, and pos is the load-
 *  bearing field interp can never inherit). */
export const V4_MASK_VEL = 0x02;
export const V4_MASK_ROT = 0x04;
export const V4_MASK_HP_PING = 0x08;
export const V4_MASK_FLAGS_SHEEP = 0x10;
/** All groups present — the encoder's "fresh" record carries every bit,
 *  which is also the ONLY record a baseline-less decoder may accept. */
export const V4_MASK_FULL = V4_MASK_VEL | V4_MASK_ROT | V4_MASK_HP_PING | V4_MASK_FLAGS_SHEEP;

/** Basis depth: each encode masks against the state from this many
 *  encodes ago, so a field that changed once rides the wire K times —
 *  a dropped datagram (or short burst) self-heals on the next frame
 *  instead of waiting on the forced full. Per-client acked baselines
 *  would be tighter still, but cost an encode per recipient; this
 *  shared K-basis buys most of the same loss resilience for free. */
export const V4_BASIS_DEPTH = 3;

interface V4Snap {
  wireId: number;
  velX: number; velY: number; velZ: number;
  yaw: number; pitch: number;
  hp: number; flags: number; sheepJet: number;
}

/** Encoder-side retained state per record slot — a ring of the last
 *  V4_BASIS_DEPTH wire-QUANTIZED states, so the mask decision matches
 *  what the receiver will have, not the pre-quantization floats.
 *  `wireId` detects slot reuse: a reassigned wireId forces a full
 *  record. ringPos always points at the oldest slot (next to retire). */
export interface V4Last {
  ringPos: number;
  slots: V4Snap[];
}
export function v4Last(): V4Last {
  return { ringPos: 0, slots: Array.from({ length: V4_BASIS_DEPTH }, snap) };
}

/** v4 record: wireId(2) + mask(1) + pos(12, i32×3) + present groups.
 *  Full record = 30B, minimum delta = 15B. */
export function encodeTickPlayerV4(wireId: number, p: WireTickPlayer, into: TickEncodeScratch, last: V4Last, forceFull: boolean): Uint8Array {
  const { buf, u8, d } = into;
  // Quantize first — the mask compares wire values, so sub-LSB wiggle
  // doesn't churn bytes for nothing.
  const velX = Math.round(p.velocity.x * 10), velY = Math.round(p.velocity.y * 10), velZ = Math.round(p.velocity.z * 10);
  const yaw = Math.round(((p.rotation.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) * (65_535 / (Math.PI * 2)));
  const pitch = Math.round(Math.max(-Math.PI, Math.min(Math.PI, p.rotation.pitch)) * (32_767 / Math.PI));
  const hp = Math.max(0, Math.min(65_535, Math.round(p.health)));
  const pingB = p.ping === undefined ? 0 : Math.max(0, Math.min(255, Math.round(p.ping)));
  const flags = (p.isDead ? 1 : 0) | (p.ski ? 2 : 0) | ((p.status ?? 0) & STATUS_MASK);
  const sheepJet = Math.max(0, Math.min(100, Math.round(p.sheep ?? 0))) | (p.jet ? 0x80 : 0);
  const basis = last.slots[last.ringPos]!;
  const fresh = forceFull || basis.wireId !== wireId || basis.hp < 0;
  let mask = 0;
  if (fresh || basis.velX !== velX || basis.velY !== velY || basis.velZ !== velZ) {mask |= V4_MASK_VEL;}
  if (fresh || basis.yaw !== yaw || basis.pitch !== pitch) {mask |= V4_MASK_ROT;}
  if (fresh || basis.hp !== hp) {mask |= V4_MASK_HP_PING;}
  // flags and sheepJet share the group: one byte each, splitting buys 1B
  // at the cost of another mask bit.
  if (fresh || basis.flags !== flags || basis.sheepJet !== sheepJet) {mask |= V4_MASK_FLAGS_SHEEP;}
  let o = 0;
  d.setUint16(o, wireId, true); o += 2;
  u8[((o += 1) - 1)] = mask;
  o = packPos(d, o, p.position.x, p.position.y, p.position.z);
  if (mask & V4_MASK_VEL) { d.setInt16(o, velX, true); o += 2; d.setInt16(o, velY, true); o += 2; d.setInt16(o, velZ, true); o += 2; }
  if (mask & V4_MASK_ROT) { d.setUint16(o, yaw, true); o += 2; d.setInt16(o, pitch, true); o += 2; }
  if (mask & V4_MASK_HP_PING) { d.setUint16(o, hp, true); o += 2; u8[((o += 1) - 1)] = pingB; }
  if (mask & V4_MASK_FLAGS_SHEEP) { u8[((o += 1) - 1)] = flags; u8[((o += 1) - 1)] = sheepJet; }
  // A fresh basis reseeds every slot so subsequent deltas mask against
  // THIS state — the K-send redundancy window starts clean, not against
  // whatever the retired owner's history still held.
  if (fresh) {
    for (const s of last.slots) {
      s.wireId = wireId; s.velX = velX; s.velY = velY; s.velZ = velZ;
      s.yaw = yaw; s.pitch = pitch; s.hp = hp; s.flags = flags; s.sheepJet = sheepJet;
    }
  } else {
    basis.wireId = wireId; basis.velX = velX; basis.velY = velY; basis.velZ = velZ;
    basis.yaw = yaw; basis.pitch = pitch; basis.hp = hp; basis.flags = flags; basis.sheepJet = sheepJet;
  }
  last.ringPos = (last.ringPos + 1) % last.slots.length;
  return new Uint8Array(buf, 0, o);
}

/** Far-tier sparse variant: strip VEL|ROT groups from an encoded v4
 *  record. Masked-out groups emit the receiver's retained slot values,
 *  so a >600m speck keeps dead-reckoning its last-seen velocity instead
 *  of paying 10B/record for a refresh it can't resolve on screen anyway
 *  (15-20B vs 25-30B). Never substitute on force sends — knockback
 *  extrapolation needs the vel. Writes into `into` like the encoders. */
export function sparseV4Record(rec: Uint8Array, into: TickEncodeScratch): Uint8Array {
  const mask = rec[2]! & ~(V4_MASK_VEL | V4_MASK_ROT);
  const { u8: out } = into;
  out[0] = rec[0]!; out[1] = rec[1]!; out[2] = mask;
  out.set(rec.subarray(3, 15), 3); // wireId u16 + mask + pos i32×3
  let i = 15, o = 15;
  if (rec[2]! & V4_MASK_VEL) {i += 6;}
  if (rec[2]! & V4_MASK_ROT) {i += 4;}
  if (rec[2]! & V4_MASK_HP_PING) {out.set(rec.subarray(i, i + 3), o); o += 3; i += 3;}
  if (rec[2]! & V4_MASK_FLAGS_SHEEP) {out.set(rec.subarray(i, i + 2), o); o += 2;}
  return out.subarray(0, o);
}

// ---- S→C ballSegment (highest-rate event: every bounce/heartbeat) ----

const SEG_KINDS = ['bounce', 'lunge', 'enrage', 'stall', 'teleport', 'spawn', 'knockback', 'hit', 'segment'] as const;
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
  const idBytes = s.targetId === null ? null : ENC.encode(s.targetId);
  const buf = new ArrayBuffer(56 + (idBytes ? 1 + idBytes.length : 0));
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  let o = 0;
  d.setUint8(((o += 1) - 1), MAGIC);
  d.setUint8(((o += 1) - 1), WIRE_BALLSEG);
  d.setUint32(o, s.id >>> 0, true); o += 4;
  d.setUint8(((o += 1) - 1), segKindIdx.get(s.kind) ?? 0);
  d.setFloat32(o, s.t, true); o += 4;
  d.setFloat32(o, s.position.x, true); o += 4;
  d.setFloat32(o, s.position.y, true); o += 4;
  d.setFloat32(o, s.position.z, true); o += 4;
  d.setFloat32(o, s.velocity.x, true); o += 4;
  d.setFloat32(o, s.velocity.y, true); o += 4;
  d.setFloat32(o, s.velocity.z, true); o += 4;
  d.setUint8(((o += 1) - 1),
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
    d.setUint8(((o += 1) - 1), idBytes.length);
    u8.set(idBytes, o); o += idBytes.length;
  }
  return new Uint8Array(buf, 0, o);
}

export function decodeBallSegment(u8: Uint8Array): WireBallSegment | null {
  return decodeBallSegmentAt(u8, 0)?.seg ?? null;
}

/** Batch container: one frame per tick carries every ball segment —
 *  ~250 tiny reliable frames/s at 25 balls become ≤20/s. */
export const WIRE_BALLBATCH = 0x0A; // 0x04/0x05 are tick-family tags — lane routers treat them as tickUpdate

// ---- S→C projectile edges (~45% of client down at 32 seats as JSON) ----
// create: ~46B+shotId vs ~200B JSON; gone: ~18B+shotId vs ~120B JSON.
export const WIRE_PROJSPAWN = 0x0B;
export const WIRE_PROJGONE = 0x0C;
/** Per-conn tick coalescing: everything a socket earns in one tick
 *  (tick frame + in-tick events) ships as ONE send — u16 len-prefixed
 *  subframes. Cuts socket-write syscalls ~3-4× under combat. */
export const WIRE_BATCH = 0x0D;

export function encodeBatch(frames: Uint8Array[], into?: Uint8Array): Uint8Array {
  let n = 2;
  for (const f of frames) {n += 2 + f.length;}
  // `into` callers pass a send-consumed-synchronously scratch — the view
  // is overwritten by the next batch, so it's only safe where the send
  // copies at call time (uWS does).
  const out = into && into.byteLength >= n ? into.subarray(0, n) : new Uint8Array(n);
  const d = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = MAGIC; out[1] = WIRE_BATCH;
  let o = 2;
  for (const f of frames) {d.setUint16(o, f.length, true); o += 2; out.set(f, o); o += f.length;}
  return out;
}

/** Iterate a batch's len-prefixed subframes — each is a complete wire
 *  frame; a truncated tail just ends the walk (subframe zeroed). */
export function* iterBatch(u8: Uint8Array): Generator<Uint8Array> {
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 2;
  while (o + 2 <= u8.length) {
    const n = d.getUint16(o, true); o += 2;
    if (o + n > u8.length) {return;}
    yield u8.subarray(o, o + n);
    o += n;
  }
}

// ---- C→S binary claims (skip the JSON text lane entirely — the
// decode IS the validation: bounded reads + finite checks at the byte
// boundary, then the trusted dispatch path like position/inputMove) ----

export const WIRE_JUMP = 0x0E;
export const WIRE_JETPACK = 0x0F;
export const WIRE_SHOT = 0x10;

/** jump / jetpack: `{ type, position }` — 14B vs ~85B JSON. */
export function encodePosClaim(kind: number, pos: WireVec3): Uint8Array {
  const buf = new ArrayBuffer(14);
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  u8[0] = MAGIC; u8[1] = kind;
  d.setFloat32(2, pos.x, true); d.setFloat32(6, pos.y, true); d.setFloat32(10, pos.z, true);
  return u8;
}

export function decodePosClaim(u8: Uint8Array, kind: number): { position: WireVec3 } | null {
  if (u8.length < 14 || u8[0] !== MAGIC || u8[1] !== kind) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const x = d.getFloat32(2, true), y = d.getFloat32(6, true), z = d.getFloat32(10, true);
  if (!Number.isFinite(x + y + z)) {return null;}
  return { position: { x, y, z } };
}

/** shotFired: weaponType u8 + presence flags + optional pos/dir/shotId
 *  + fireAt f64. Field PRESENCE is semantic (a bare intent's absent dir
 *  must not spawn a shell) — flags mirror the JSON message exactly.
 *  ~12-45B vs ~190B JSON. */
export function encodeShot(s: { weaponType: number; pos?: WireVec3; dir?: WireVec3; shotId?: string; fireAt?: number }): Uint8Array {
  const sid = s.shotId ? ENC.encode(s.shotId) : null;
  const buf = new ArrayBuffer(12 + (s.pos ? 12 : 0) + (s.dir ? 12 : 0) + (sid ? 1 + sid.length : 0));
  const u8 = new Uint8Array(buf);
  const d = new DataView(buf);
  u8[0] = MAGIC; u8[1] = WIRE_SHOT;
  u8[2] = s.weaponType & 0xFF;
  u8[3] = (s.pos ? 1 : 0) | (s.dir ? 2 : 0) | (sid ? 4 : 0);
  let o = 4;
  if (s.pos) {d.setFloat32(o, s.pos.x, true); d.setFloat32(o + 4, s.pos.y, true); d.setFloat32(o + 8, s.pos.z, true); o += 12;}
  if (s.dir) {d.setFloat32(o, s.dir.x, true); d.setFloat32(o + 4, s.dir.y, true); d.setFloat32(o + 8, s.dir.z, true); o += 12;}
  if (sid) {u8[o] = sid.length; u8.set(sid, o + 1); o += 1 + sid.length;}
  d.setFloat64(o, s.fireAt ?? 0, true);
  return u8;
}

export function decodeShot(u8: Uint8Array): { weaponType: number; pos?: WireVec3; dir?: WireVec3; shotId?: string; fireAt?: number } | null {
  if (u8.length < 12 || u8[0] !== MAGIC || u8[1] !== WIRE_SHOT) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const flags = u8[3]!;
  let o = 4;
  const r: { weaponType: number; pos?: WireVec3; dir?: WireVec3; shotId?: string; fireAt?: number } = { weaponType: u8[2]! };
  if (flags & 1) {
    if (o + 12 > u8.length) {return null;}
    const x = d.getFloat32(o, true), y = d.getFloat32(o + 4, true), z = d.getFloat32(o + 8, true);
    if (!Number.isFinite(x + y + z)) {return null;}
    r.pos = { x, y, z }; o += 12;
  }
  if (flags & 2) {
    if (o + 12 > u8.length) {return null;}
    const x = d.getFloat32(o, true), y = d.getFloat32(o + 4, true), z = d.getFloat32(o + 8, true);
    if (!Number.isFinite(x + y + z)) {return null;}
    r.dir = { x, y, z }; o += 12;
  }
  if (flags & 4) {
    if (o + 1 > u8.length) {return null;}
    const n = u8[o]!;
    if (o + 1 + n > u8.length) {return null;}
    r.shotId = DEC.decode(u8.subarray(o + 1, o + 1 + n)); o += 1 + n;
  }
  if (o + 8 > u8.length) {return null;}
  const fireAt = d.getFloat64(o, true);
  if (!Number.isFinite(fireAt)) {return null;}
  r.fireAt = fireAt;
  return r;
}

/** S→C playerHit — the hot combat event (~160B JSON → ~20B). Ids are
 *  room wireIds (u16); shooterWid 0 = 'environment'. Presence flags
 *  cover armor/shotId/gd — the same optional fields the JSON carries. */
export const WIRE_HIT = 0x13;

export interface WireHit { targetWid: number; shooterWid: number; damage: number; health: number; armor?: number; seq?: number; shotId?: string; gd?: number }

export function encodeHit(h: WireHit): Uint8Array {
  const sid = h.shotId ? ENC.encode(h.shotId) : null;
  const len = 15 + (h.armor === undefined ? 0 : 4) + (h.seq === undefined ? 0 : 4) + (sid ? 1 + sid.length : 0) + (h.gd === undefined ? 0 : 4);
  const { u8, dv } = evScratch(len);
  const b = u8.byteOffset;
  u8[0] = MAGIC; u8[1] = WIRE_HIT;
  dv.setUint16(b + 2, h.targetWid, true); dv.setUint16(b + 4, h.shooterWid, true);
  dv.setFloat32(b + 6, h.damage, true); dv.setFloat32(b + 10, h.health, true);
  u8[14] = (h.armor === undefined ? 0 : 1) | (h.seq === undefined ? 0 : 2) | (sid ? 4 : 0) | (h.gd === undefined ? 0 : 8);
  let o = 15;
  if (h.armor !== undefined) {dv.setFloat32(b + o, h.armor, true); o += 4;}
  if (h.seq !== undefined) {dv.setUint32(b + o, h.seq >>> 0, true); o += 4;}
  if (sid) {u8[o] = sid.length; u8.set(sid, o + 1); o += 1 + sid.length;}
  if (h.gd !== undefined) {dv.setFloat32(b + o, h.gd, true);}
  return u8.subarray(0, len);
}

export function decodeHit(u8: Uint8Array): WireHit | null {
  if (u8.length < 15 || u8[0] !== MAGIC || u8[1] !== WIRE_HIT) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const flags = u8[14]!;
  const r: WireHit = {
    targetWid: d.getUint16(2, true), shooterWid: d.getUint16(4, true),
    damage: d.getFloat32(6, true), health: d.getFloat32(10, true),
  };
  if (!Number.isFinite(r.damage + r.health)) {return null;}
  let o = 15;
  if (flags & 1) {if (o + 4 > u8.length) {return null;} r.armor = d.getFloat32(o, true); o += 4;}
  if (flags & 2) {if (o + 4 > u8.length) {return null;} r.seq = d.getUint32(o, true); o += 4;}
  if (flags & 4) {if (o + 1 > u8.length) {return null;} const n = u8[o]!; if (o + 1 + n > u8.length) {return null;} r.shotId = DEC.decode(u8.subarray(o + 1, o + 1 + n)); o += 1 + n;}
  if (flags & 8) {if (o + 4 > u8.length) {return null;} r.gd = d.getFloat32(o, true); o += 4;}
  return r;
}

// ---- S→C binary event relays (the wireId+pos family — same pattern as
// WIRE_HIT, decoded through the normal message() dispatch) ----

/** Outbound event-frame ring: encoders write through a shared DataView
 *  into the next slot, return a sized subarray view. A frame stays valid
 *  until EV_SLOTS further encodes (~10+ ticks of headroom at real event
 *  rates) — the collect path consumes at tick-end flush, immediate sends
 *  at ws.send(). Anything retained longer (the reclaim journal, segment
 *  queues) MUST copy — that's one slice() per journaled event instead
 *  of a buffer+view+DataView alloc per encode. len > EV_SLOT falls back
 *  to a normal alloc, so callers never branch. */
const EV_SLOTS = 128;
const EV_SLOT = 256;
const evBuf = new ArrayBuffer(EV_SLOTS * EV_SLOT);
const evDv = new DataView(evBuf);
const evViews: Uint8Array[] = [];
for (let i = 0; i < EV_SLOTS; i++) {evViews.push(new Uint8Array(evBuf, i * EV_SLOT, EV_SLOT));}
let evAt = 0;

export function evScratch(len: number): { u8: Uint8Array; dv: DataView } {
  if (len > EV_SLOT) {
    const buf = new ArrayBuffer(len);
    return { u8: new Uint8Array(buf), dv: new DataView(buf) };
  }
  const u8 = evViews[evAt]!;
  evAt = (evAt + 1) % EV_SLOTS;
  return { u8, dv: evDv };
}

/** True when `u8` is a view into the shared ring — any sink that RETAINS
 *  the frame past the next evScratch() call must copy. Queued outbox
 *  frames are the hazard: >128 distinct encodes before flush wraps the
 *  ring and rewrites the queued bytes into a different event. */
export function isEvScratch(u8: Uint8Array): boolean {
  return u8.buffer === evBuf;
}

export const WIRE_E_JUMP = 0x14;
export const WIRE_E_JET = 0x15;
export const WIRE_E_LANDED = 0x16;
export const WIRE_E_SHOT = 0x17;
export const WIRE_E_KNOCK = 0x18;
export const WIRE_KILL = 0x19;

/** jump / jetpack relay (+ landed carries a f32 impact trailing the pos). */
export function encodeWidPos(kind: number, wid: number, pos: WireVec3, extra?: number): Uint8Array {
  const len = extra === undefined ? 16 : 20;
  const { u8, dv } = evScratch(len);
  const b = u8.byteOffset;
  u8[0] = MAGIC; u8[1] = kind;
  dv.setUint16(b + 2, wid, true);
  dv.setFloat32(b + 4, pos.x, true); dv.setFloat32(b + 8, pos.y, true); dv.setFloat32(b + 12, pos.z, true);
  if (extra !== undefined) {dv.setFloat32(b + 16, extra, true);}
  return u8.subarray(0, len);
}

export function decodeWidPos(u8: Uint8Array, kind: number): { wid: number; pos: WireVec3; extra?: number } | null {
  if (u8.length < 16 || u8[0] !== MAGIC || u8[1] !== kind) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const x = d.getFloat32(4, true), y = d.getFloat32(8, true), z = d.getFloat32(12, true);
  if (!Number.isFinite(x + y + z)) {return null;}
  const r: { wid: number; pos: WireVec3; extra?: number } = { wid: d.getUint16(2, true), pos: { x, y, z } };
  if (u8.length >= 20) {
    const extra = d.getFloat32(16, true);
    if (Number.isFinite(extra)) {r.extra = extra;}
  }
  return r;
}

/** playerShot cosmetic relay — pos/dir presence flags mirror the JSON. */
export function encodeShotEv(wid: number, weaponType: number | undefined, pos?: WireVec3, dir?: WireVec3): Uint8Array {
  const len = 6 + (pos ? 12 : 0) + (dir ? 12 : 0);
  const { u8, dv } = evScratch(len);
  const b = u8.byteOffset;
  u8[0] = MAGIC; u8[1] = WIRE_E_SHOT;
  dv.setUint16(b + 2, wid, true);
  u8[4] = (weaponType ?? 0xFF) & 0xFF;
  u8[5] = (pos ? 1 : 0) | (dir ? 2 : 0);
  let o = 6;
  if (pos) {dv.setFloat32(b + o, pos.x, true); dv.setFloat32(b + o + 4, pos.y, true); dv.setFloat32(b + o + 8, pos.z, true); o += 12;}
  if (dir) {dv.setFloat32(b + o, dir.x, true); dv.setFloat32(b + o + 4, dir.y, true); dv.setFloat32(b + o + 8, dir.z, true); o += 12;}
  return u8.subarray(0, len);
}

export function decodeShotEv(u8: Uint8Array): { wid: number; weaponType?: number; pos?: WireVec3; dir?: WireVec3 } | null {
  if (u8.length < 6 || u8[0] !== MAGIC || u8[1] !== WIRE_E_SHOT) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const flags = u8[5]!;
  const r: { wid: number; weaponType?: number; pos?: WireVec3; dir?: WireVec3 } = { wid: d.getUint16(2, true) };
  if (u8[4] !== 0xFF) {r.weaponType = u8[4];}
  let o = 6;
  if (flags & 1) {
    if (o + 12 > u8.length) {return null;}
    const x = d.getFloat32(o, true), y = d.getFloat32(o + 4, true), z = d.getFloat32(o + 8, true);
    if (!Number.isFinite(x + y + z)) {return null;}
    r.pos = { x, y, z }; o += 12;
  }
  if (flags & 2) {
    if (o + 12 > u8.length) {return null;}
    const x = d.getFloat32(o, true), y = d.getFloat32(o + 4, true), z = d.getFloat32(o + 8, true);
    if (!Number.isFinite(x + y + z)) {return null;}
    r.dir = { x, y, z };
  }
  return r;
}

/** knockback — victim-only send: wid + pos + force + pull/yank flags. */
export function encodeKnock(wid: number, pos: WireVec3, force: number, pull?: boolean, yank?: boolean): Uint8Array {
  const { u8, dv } = evScratch(21);
  const b = u8.byteOffset;
  u8[0] = MAGIC; u8[1] = WIRE_E_KNOCK;
  dv.setUint16(b + 2, wid, true);
  dv.setFloat32(b + 4, pos.x, true); dv.setFloat32(b + 8, pos.y, true); dv.setFloat32(b + 12, pos.z, true);
  dv.setFloat32(b + 16, force, true);
  u8[20] = (pull ? 1 : 0) | (yank ? 2 : 0);
  return u8.subarray(0, 21);
}

export function decodeKnock(u8: Uint8Array): { wid: number; pos: WireVec3; force: number; pull?: boolean; yank?: boolean } | null {
  if (u8.length < 21 || u8[0] !== MAGIC || u8[1] !== WIRE_E_KNOCK) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const x = d.getFloat32(4, true), y = d.getFloat32(8, true), z = d.getFloat32(12, true);
  const force = d.getFloat32(16, true);
  if (!Number.isFinite(x + y + z + force)) {return null;}
  const flags = u8[20]!;
  return { wid: d.getUint16(2, true), pos: { x, y, z }, force, ...(flags & 1 ? { pull: true } : {}), ...(flags & 2 ? { yank: true } : {}) };
}

/** playerKill — durable journal event: shooter/target wireIds + optional
 *  weapon (0xFF = none), streak u16, air f32, steal bit. */
export function encodeKill(k: { shooterWid: number; targetWid: number; weapon?: number; streak?: number; air?: number; steal?: boolean }): Uint8Array {
  const len = 8 + (k.streak === undefined ? 0 : 2) + (k.air === undefined ? 0 : 4);
  const { u8, dv } = evScratch(len);
  const b = u8.byteOffset;
  u8[0] = MAGIC; u8[1] = WIRE_KILL;
  dv.setUint16(b + 2, k.shooterWid, true); dv.setUint16(b + 4, k.targetWid, true);
  u8[6] = (k.weapon ?? 0xFF) & 0xFF;
  u8[7] = (k.streak === undefined ? 0 : 1) | (k.air === undefined ? 0 : 2) | (k.steal ? 4 : 0);
  let o = 8;
  if (k.streak !== undefined) {dv.setUint16(b + o, k.streak, true); o += 2;}
  if (k.air !== undefined) {dv.setFloat32(b + o, k.air, true); o += 4;}
  return u8.subarray(0, len);
}

export function decodeKill(u8: Uint8Array): { shooterWid: number; targetWid: number; weapon?: number; streak?: number; air?: number; steal?: boolean } | null {
  if (u8.length < 8 || u8[0] !== MAGIC || u8[1] !== WIRE_KILL) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const flags = u8[7]!;
  const r: { shooterWid: number; targetWid: number; weapon?: number; streak?: number; air?: number; steal?: boolean } = {
    shooterWid: d.getUint16(2, true), targetWid: d.getUint16(4, true),
  };
  if (u8[6] !== 0xFF) {r.weapon = u8[6];}
  let o = 8;
  if (flags & 1) {if (o + 2 > u8.length) {return null;} r.streak = d.getUint16(o, true); o += 2;}
  if (flags & 2) {if (o + 4 > u8.length) {return null;} const air = d.getFloat32(o, true); if (!Number.isFinite(air)) {return null;} r.air = air; o += 4;}
  if (flags & 4) {r.steal = true;}
  return r;
}

export interface WireProjSpawn {
  projId: number;          // numeric tail of 'sp-N'
  ownerWireId: number;     // room wireId — receiver resolves via its roster
  weaponType: number;
  pellet: number | undefined;
  age: number;             // server shell age (lagS) at emit
  t: number;               // server wall ms — client computes transit via clockOffset
  position: WireVec3;
  velocity: WireVec3;
  shotId: string | undefined; // owner's bind nonce — meaningless to others
}

export function encodeProjSpawn(s: WireProjSpawn): Uint8Array {
  const sid = s.shotId === undefined ? null : ENC.encode(s.shotId);
  const len = 46 + (sid ? 1 + sid.length : 0);
  const { u8, dv } = evScratch(len);
  const b = u8.byteOffset;
  let o = 0;
  u8[o++] = MAGIC; u8[o++] = WIRE_PROJSPAWN;
  dv.setUint32(b + o, s.projId >>> 0, true); o += 4;
  dv.setUint16(b + o, s.ownerWireId, true); o += 2;
  u8[o++] = s.weaponType & 0xFF;
  u8[o++] = s.pellet === undefined ? 0xFF : s.pellet & 0xFF;
  dv.setFloat32(b + o, s.age, true); o += 4;
  dv.setFloat64(b + o, s.t, true); o += 8;
  dv.setFloat32(b + o, s.position.x, true); dv.setFloat32(b + o + 4, s.position.y, true); dv.setFloat32(b + o + 8, s.position.z, true); o += 12;
  dv.setFloat32(b + o, s.velocity.x, true); dv.setFloat32(b + o + 4, s.velocity.y, true); dv.setFloat32(b + o + 8, s.velocity.z, true); o += 12;
  if (sid) { u8[o++] = sid.length; u8.set(sid, o); }
  return u8.subarray(0, len);
}

export function decodeProjSpawn(u8: Uint8Array): WireProjSpawn | null {
  if (u8.length < 46 || u8[0] !== MAGIC || u8[1] !== WIRE_PROJSPAWN) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 2;
  const projId = d.getUint32(o, true); o += 4;
  const ownerWireId = d.getUint16(o, true); o += 2;
  const weaponType = d.getUint8(o++);
  const pelletB = d.getUint8(o++);
  const age = d.getFloat32(o, true); o += 4;
  const t = d.getFloat64(o, true); o += 8;
  const position = { x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true) }; o += 12;
  const velocity = { x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true) }; o += 12;
  let shotId: string | undefined;
  if (o < u8.length) {
    const n = d.getUint8(o++);
    if (o + n > u8.length) {return null;}
    shotId = DEC.decode(u8.subarray(o, o + n));
  }
  if (!Number.isFinite(age + t) ||
      !Number.isFinite(position.x + position.y + position.z) ||
      !Number.isFinite(velocity.x + velocity.y + velocity.z)) {return null;}
  return { projId, ownerWireId, weaponType, pellet: pelletB === 0xFF ? undefined : pelletB, age, t, position, velocity, shotId };
}

export interface WireProjGone {
  projId: number;
  age: number;
  position: WireVec3;
  shotId: string | undefined;
}

export function encodeProjGone(g: WireProjGone): Uint8Array {
  const sid = g.shotId === undefined ? null : ENC.encode(g.shotId);
  const len = 22 + (sid ? 1 + sid.length : 0);
  const { u8, dv } = evScratch(len);
  const b = u8.byteOffset;
  let o = 0;
  u8[o++] = MAGIC; u8[o++] = WIRE_PROJGONE;
  dv.setUint32(b + o, g.projId >>> 0, true); o += 4;
  dv.setFloat32(b + o, g.age, true); o += 4;
  dv.setFloat32(b + o, g.position.x, true); dv.setFloat32(b + o + 4, g.position.y, true); dv.setFloat32(b + o + 8, g.position.z, true); o += 12;
  if (sid) { u8[o++] = sid.length; u8.set(sid, o); }
  return u8.subarray(0, len);
}

export function decodeProjGone(u8: Uint8Array): WireProjGone | null {
  if (u8.length < 22 || u8[0] !== MAGIC || u8[1] !== WIRE_PROJGONE) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 2;
  const projId = d.getUint32(o, true); o += 4;
  const age = d.getFloat32(o, true); o += 4;
  const position = { x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true) }; o += 12;
  let shotId: string | undefined;
  if (o < u8.length) {
    const n = d.getUint8(o++);
    if (o + n > u8.length) {return null;}
    shotId = DEC.decode(u8.subarray(o, o + n));
  }
  if (!Number.isFinite(age) || !Number.isFinite(position.x + position.y + position.z)) {return null;}
  return { projId, age, position, shotId };
}


export function encodeBallBatch(segs: Uint8Array[]): Uint8Array {
  let n = 4; // magic + kind + count
  for (const s of segs) {n += s.byteLength;}
  const out = new Uint8Array(n);
  const d = new DataView(out.buffer);
  d.setUint8(0, MAGIC); d.setUint8(1, WIRE_BALLBATCH); d.setUint16(2, segs.length, true);
  let o = 4;
  for (const s of segs) { out.set(s, o); o += s.byteLength; }
  return out;
}

/** Parse one batch member at `off`; consumed = seg's own wire length. */
export function decodeBallSegmentAt(u8: Uint8Array, off: number): { seg: WireBallSegment; next: number } | null {
  if (u8.length - off < 44 || u8[off] !== MAGIC || u8[off + 1] !== WIRE_BALLSEG) {return null;}
  const d = new DataView(u8.buffer, u8.byteOffset + off, u8.byteLength - off);
  let o = 2;
  const id = d.getUint32(o, true); o += 4;
  const kind = SEG_KINDS[d.getUint8(((o += 1) - 1))] ?? 'bounce';
  const t = d.getFloat32(o, true); o += 4;
  const position = { x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true) }; o += 12;
  const velocity = { x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true) }; o += 12;
  const flags = d.getUint8(((o += 1) - 1));
  const et = d.getFloat32(o, true); o += 4;
  const slowT = d.getFloat32(o, true); o += 4;
  let tp: WireVec3 | null = null;
  if (flags & 4) {
    if (o + 12 > u8.byteLength - off) {return null;}
    tp = { x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), z: d.getFloat32(o + 8, true) }; o += 12;
  }
  let targetId: string | null = null;
  if (flags & 8) {
    if (o >= u8.byteLength - off) {return null;}
    const idLen = d.getUint8(((o += 1) - 1));
    if (o + idLen > u8.byteLength - off) {return null;}
    targetId = DEC.decode(u8.subarray(off + o, off + o + idLen));
    o += idLen;
  }
  // Same contract as decodePosition: a NaN/Inf vector or timer poisons
  // the replay sim - refuse the segment, don't sanitize it downstream.
  if (!Number.isFinite(position.x + position.y + position.z) ||
      !Number.isFinite(velocity.x + velocity.y + velocity.z) ||
      !Number.isFinite(t + et + slowT) ||
      (tp !== null && !Number.isFinite(tp.x + tp.y + tp.z))) {return null;}
  return {
    seg: {
      id, kind, position, velocity,
      enraged: (flags & 1) !== 0,
      damp: (flags & 2) !== 0,
      targetId, tp, et, slowT, t,
    },
    next: off + o,
  };
}

/** Batch frame → every member segment. Truncated members end the walk. */
export function decodeBallBatch(u8: Uint8Array): WireBallSegment[] {
  if (u8.length < 4 || u8[0] !== MAGIC || u8[1] !== WIRE_BALLBATCH) {return [];}
  const count = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint16(2, true);
  const out: WireBallSegment[] = [];
  let o = 4;
  for (let i = 0; i < count; i++) {
    const r = decodeBallSegmentAt(u8, o);
    if (!r) {break;}
    out.push(r.seg); o = r.next;
  }
  return out;
}

/** Single-or-batch: every segment a ball-lane frame carries. */
export function decodeBallAny(u8: Uint8Array): WireBallSegment[] {
  if (u8[1] === WIRE_BALLBATCH) {return decodeBallBatch(u8);}
  const s = decodeBallSegment(u8);
  return s ? [s] : [];
}

