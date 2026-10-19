import { describe, it, expect } from 'vitest';
import type { WireTickPlayer } from '../../../shared/wire.js';
import {
  encodePosition, decodePosition,
  encodeTickPlayer, encodeTickPlayerV3, encodeTickPlayerV4, encodeTickFrame, decodeTickFrame,
  isWireFrame, WIRE_POSITION, WIRE_TICK_V3, WIRE_TICK_V4, WireIdRoster,
  tickEncodeScratch, v4Last,encodeBallSegment,decodeBallSegment,sparseV4Record
} from '../../../shared/wire';

const encPos = (pos: { x: number; y: number; z: number }): Uint8Array<ArrayBufferLike> =>
  encodePosition(pos, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0);

const recTick = (id: string, over: Partial<Parameters<typeof encodeTickPlayer>[0]> = {}): Uint8Array<ArrayBufferLike> =>
  encodeTickPlayer(Object.assign({playerId: id,position: { x: 1, y: 2, z: 3 },rotation: { yaw: 0.5, pitch: -0.5 },velocity: { x: 4, y: 5, z: 6 },health: 300,isDead: false,ping: 55,ski: 1}, over));

const mkRoster = (): WireIdRoster => {
  const r = new WireIdRoster();
  r.feed({ type: 'wireIds', add: { 7: 'player_seven', 9: 'player_nine' } });
  return r;
};

const baseTickP = (): WireTickPlayer => ({
  playerId: '', position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0.5, pitch: 0.1 },
  velocity: { x: 10, y: 0, z: 5 }, health: 100, isDead: false, ski: 1, jet: 0, status: 0, sheep: 40, ping: 50,
});

describe('position frame round-trip', (): void => {
  it('preserves position exactly (float32)', (): void => {
    const pos = { x: 123.456, y: -78.9, z: 0.5 };
    const rot = { yaw: 1.234, pitch: -0.9 };
    const vel = { x: 12.34, y: -5.6, z: 100.1 };
    const decoded = decodePosition(encodePosition(pos, rot, vel, 42, 37));
    expect(decoded).not.toBeNull();
    expect(decoded!.position.x).toBeCloseTo(pos.x, 5);
    expect(decoded!.position.y).toBeCloseTo(pos.y, 5);
    expect(decoded!.position.z).toBeCloseTo(pos.z, 5);
    expect(decoded!.seq).toBe(42);
    expect(decoded!.ping).toBe(37);
  });

  it('quantizes velocity to 0.1 m/s', (): void => {
    const vel = { x: 1.04, y: 1.05, z: 1.06 };
    const d = decodePosition(encodePosition({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, vel, 1, 0))!;
    expect(d.velocity.x).toBeCloseTo(1, 5);
    expect(d.velocity.z).toBeCloseTo(1.1, 5);
  });

  it('wraps yaw into [0, 2π) and clamps pitch', (): void => {
    const neg = decodePosition(encodePosition({ x: 0, y: 0, z: 0 }, { yaw: -0.5, pitch: 99 }, { x: 0, y: 0, z: 0 }, 1, 0))!;
    expect(neg.rotation.yaw).toBeGreaterThanOrEqual(0);
    expect(neg.rotation.yaw).toBeCloseTo(Math.PI * 2 - 0.5, 2);
    expect(neg.rotation.pitch).toBeCloseTo(Math.PI, 4);
  });

  it('rejects non-wire and truncated frames', (): void => {
    expect(decodePosition(new Uint8Array([0x00, 0x01, 2, 3]))).toBeNull();
    expect(decodePosition(new Uint8Array(10))).toBeNull();
    const good = encodePosition({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0);
    expect(decodePosition(good.slice(0, 10))).toBeNull();
  });

  it('round-trips inputSeq and decodes old 30-byte frames without it', (): void => {
    const pos = { x: 1, y: 2, z: 3 };
    const rot = { yaw: 0, pitch: 0 };
    const vel = { x: 0, y: 0, z: 0 };
    const framed = encodePosition(pos, rot, vel, 7, 12, 1234);
    expect(framed.length).toBe(34);
    expect(decodePosition(framed)!.inputSeq).toBe(1234);
    // Legacy client: no inputSeq field — frame is 30B and decodes clean.
    const legacy = encodePosition(pos, rot, vel, 7, 12);
    expect(legacy.length).toBe(30);
    const d = decodePosition(legacy)!;
    expect(d.seq).toBe(7);
    expect(d.inputSeq).toBeUndefined();
  });
});

describe('tick frame round-trip', (): void => {
  it('decodes all player records with fields intact', (): void => {
    const p1 = encodeTickPlayer({
      playerId: 'player_abc', position: { x: 1, y: 2, z: 3 },
      rotation: { yaw: 0.5, pitch: -0.5 }, velocity: { x: 4, y: 5, z: 6 },
      health: 300, isDead: false, ping: 55, ski: 1,
    });
    const p2 = encodeTickPlayer({
      playerId: 'player_xyz', position: { x: -1, y: -2, z: -3 },
      rotation: { yaw: 3, pitch: 0.2 }, velocity: { x: 0, y: 0, z: 0 },
      health: 0, isDead: true, ping: undefined, ski: 0,
    });
    const frame = encodeTickFrame(77, 900, 41, [p1, p2]);
    expect(isWireFrame(frame)).toBe(true);
    const decoded = decodeTickFrame(frame)!;
    expect(decoded.ackSeq).toBe(77);
    expect(decoded.tickSeq).toBe(900);
    expect(decoded.inputAck).toBe(41);
    expect(decoded.updates).toHaveLength(2);
    const [a, b] = decoded.updates;
    expect(a!.playerId).toBe('player_abc');
    // Heavy/bot hp runs past the old u8 record — >255 must survive the wire.
    expect(a!.health).toBe(300);
    expect(a!.ping).toBe(55);
    expect(a!.ski).toBe(1);
    expect(a!.isDead).toBe(false);
    expect(b!.isDead).toBe(true);
    expect(b!.ping).toBeUndefined(); // unproven ping stays undefined
    expect(b!.rotation.pitch).toBeCloseTo(0.2, 2);
  });

  it('position quantization stays within POS_Q/2 at any in-range coordinate', (): void => {
    // POS_Q=0.04 i16 grid: decoded pos may drift ≤2cm — fine for the
    // interp-only consumers (upsertRemotePlayer), a hard error if any
    // future path seeds sim state from tick records.
    const cases = [
      { x: 0, y: 0, z: 0 },
      { x: 1.001, y: -2.999, z: 0.019 },
      { x: 1300.9, y: -1300.9, z: 512.337 },
      { x: -1299.111, y: 222.422, z: -88.888 },
    ];
    for (const pos of cases) {
      const p = encodeTickPlayer({
        playerId: 'p', position: pos,
        rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
        health: 100, isDead: false, ping: undefined, ski: 0,
      });
      const decoded = decodeTickFrame(encodeTickFrame(0, 0, 0, [p]))!;
      const q = decoded.updates[0]!.position;
      expect(Math.abs(q.x - pos.x)).toBeLessThanOrEqual(0.02);
      expect(Math.abs(q.y - pos.y)).toBeLessThanOrEqual(0.02);
      expect(Math.abs(q.z - pos.z)).toBeLessThanOrEqual(0.02);
    }
  });

  it('rejects truncated frames', (): void => {
    const p = encodeTickPlayer({
      playerId: 'a', position: { x: 0, y: 0, z: 0 },
      rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
      health: 100, isDead: false, ski: 0,
    });
    const frame = encodeTickFrame(0, 0, 0, [p]);
    expect(decodeTickFrame(frame.slice(0, frame.length - 5))).toBeNull();
  });

  it('isWireFrame gates the magic byte only', (): void => {
    expect(isWireFrame(new Uint8Array([0x54, WIRE_POSITION]))).toBe(true);
    expect(isWireFrame(new Uint8Array([0x53, WIRE_POSITION]))).toBe(false);
    expect(isWireFrame(new Uint8Array([0x54]))).toBe(false);
  });
});


describe('ballSegment binary codec', (): void => {
  const full = {
    id: 42, kind: 'enrage',
    position: { x: 12.5, y: -3.25, z: 999.5 },
    velocity: { x: 40.1, y: -12.75, z: 0.5 },
    enraged: true, targetId: 'player_abc', tp: { x: 1, y: 2, z: 3 },
    et: 12.34, slowT: 1.9, damp: true, t: 1234.5,
  };

  it('round-trips all fields', (): void => {
    const s = decodeBallSegment(encodeBallSegment(full))!;
    expect(s).not.toBeNull();
    expect(s.id).toBe(42);
    expect(s.kind).toBe('enrage');
    expect(s.position.x).toBeCloseTo(12.5);
    expect(s.velocity.y).toBeCloseTo(-12.75);
    expect(s.enraged).toBe(true);
    expect(s.damp).toBe(true);
    expect(s.targetId).toBe('player_abc');
    expect(s.tp!.z).toBeCloseTo(3);
    expect(s.et).toBeCloseTo(12.34, 1);
    expect(s.slowT).toBeCloseTo(1.9, 1);
    expect(s.t).toBeCloseTo(1234.5);
  });

  it('omits optional fields cleanly', (): void => {
    const s = decodeBallSegment(encodeBallSegment(Object.assign({}, full, {targetId: null,tp: null,damp: false})))!;
    expect(s.targetId).toBeNull();
    expect(s.tp).toBeNull();
    expect(s.damp).toBe(false);
  });

  it('is ~3x smaller than JSON', (): void => {
    const bin = encodeBallSegment(full);
    const json = JSON.stringify(Object.assign({type: 'ballSegment'}, full));
    expect(bin.length).toBeLessThan(json.length / 3);
  });

  it('rejects garbage', (): void => {
    expect(decodeBallSegment(new Uint8Array(10))).toBeNull();
  });

  it('decodes each flag bit independently', (): void => {
    const base = { id: 1, kind: 'segment', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, et: 0, slowT: 0, t: 1 };
    const d = (over: object) => decodeBallSegment(encodeBallSegment(Object.assign({}, base, {enraged: false,damp: false,tp: null,targetId: null}, over)))!;
    expect(d({ enraged: true }).enraged).toBe(true);
    expect(d({ enraged: true }).damp).toBe(false);
    expect(d({ damp: true }).enraged).toBe(false);
    expect(d({ damp: true }).damp).toBe(true);
    expect(d({ tp: { x: 5, y: 6, z: 7 } }).tp).toEqual({ x: 5, y: 6, z: 7 });
    expect(d({ targetId: 'p9' }).targetId).toBe('p9');
    expect(d({ tp: { x: 5, y: 6, z: 7 } }).targetId).toBeNull();
  });

  it('falls back to bounce on an unknown kind index', (): void => {
    const bin = encodeBallSegment({ id: 1, kind: 'enrage', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, enraged: false, damp: false, tp: null, targetId: null, et: 0, slowT: 0, t: 0 });
    bin[6] = 200; // kind index beyond SEG_KINDS
    expect(decodeBallSegment(bin)!.kind).toBe('bounce');
  });

  it('rejects a targetId length that overruns the frame', (): void => {
    const bin = encodeBallSegment({ id: 1, kind: 'segment', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, enraged: false, damp: false, tp: null, targetId: 'player_abc', et: 0, slowT: 0, t: 0 });
    // Corrupt the trailing idLen so the declared id runs past the buffer.
    bin[bin.length - 'player_abc'.length - 1] = 200;
    expect(decodeBallSegment(bin)).toBeNull();
  });

  it('rejects truncation at every record boundary', (): void => {
    const bin = encodeBallSegment({ id: 1, kind: 'segment', position: { x: 1, y: 2, z: 3 }, velocity: { x: 4, y: 5, z: 6 }, enraged: true, damp: true, tp: { x: 7, y: 8, z: 9 }, targetId: 'p', et: 1, slowT: 2, t: 3 });
    // The decoder's floor is 44B; anything shorter must fail, and so must
    // a frame whose optional tail is cut mid-field.
    for (let len = 0; len < 44; len += 1) {
      expect(decodeBallSegment(bin.slice(0, len))).toBeNull();
    }
  });
});

describe('position frame adversarial decode', (): void => {

  it('rejects absurd and non-finite positions', (): void => {
    // 8192m bound — the JSON validator's same radius.
    expect(decodePosition(encPos({ x: 9000, y: 0, z: 0 }))).toBeNull();
    // Sphere, not per-axis: 6000 on two axes exceeds the bound together.
    expect(decodePosition(encPos({ x: 6000, y: 6000, z: 0 }))).toBeNull();
    expect(decodePosition(encPos({ x: 8191, y: 0, z: 0 }))).not.toBeNull();

    const nan = encPos({ x: 0, y: 0, z: 0 });
    new DataView(nan.buffer).setFloat32(6, Number.NaN, true); // pos.x
    expect(decodePosition(nan)).toBeNull();

    const inf = encPos({ x: 0, y: 0, z: 0 });
    new DataView(inf.buffer).setFloat32(10, Number.POSITIVE_INFINITY, true); // pos.y
    expect(decodePosition(inf)).toBeNull();
  });
});

describe('tick frame adversarial decode', (): void => {

  it('decodes every record distinctly (offset drift)', (): void => {
    const frame = encodeTickFrame(0, 0, 0, [
      recTick('p_one', { health: 111, velocity: { x: 1, y: 0, z: 0 } }),
      recTick('p_two', { health: 222, velocity: { x: 0, y: 2, z: 0 } }),
      recTick('p_three', { health: 333, velocity: { x: 0, y: 0, z: 3 } }),
    ]);
    const d = decodeTickFrame(frame)!;
    expect(d.count).toBe(3);
    expect(d.updates[0]!.playerId).toBe('p_one');
    expect(d.updates[0]!.health).toBe(111);
    expect(d.updates[0]!.velocity.x).toBeCloseTo(1);
    expect(d.updates[1]!.playerId).toBe('p_two');
    expect(d.updates[1]!.health).toBe(222);
    expect(d.updates[1]!.velocity.y).toBeCloseTo(2);
    expect(d.updates[2]!.playerId).toBe('p_three');
    expect(d.updates[2]!.health).toBe(333);
    expect(d.updates[2]!.velocity.z).toBeCloseTo(3);
  });

  it('rejects a declared count larger than the records present', (): void => {
    const frame = encodeTickFrame(0, 0, 0, [recTick('p1')]);
    frame[14] = 9; // count claims 9 records; only one record follows
    expect(decodeTickFrame(frame)).toBeNull();
  });

  it('decodes isDead/ski/status flag bits independently', (): void => {
    const frame = encodeTickFrame(0, 0, 0, [
      recTick('alive', { isDead: false, ski: 0, status: 0 }),
      recTick('dead_ski', { isDead: true, ski: 1, status: 0 }),
      recTick('statused', { isDead: false, ski: 0, status: 0x30 }),
    ]);
    const d = decodeTickFrame(frame)!;
    expect(d.updates[0]!.isDead).toBe(false);
    expect(d.updates[0]!.ski).toBe(0);
    expect(d.updates[1]!.isDead).toBe(true);
    expect(d.updates[1]!.ski).toBe(1);
    expect(d.updates[2]!.status).toBe(0x30);
    expect(d.updates[2]!.isDead).toBe(false);
  });

  it('round-trips positions past the old i16 bound', (): void => {
    // i16×0.04 saturated at ±1310m and clamped skiers mid-map (the dunes
    // z-freeze desync); i32 keeps the same step with ±85Mm of headroom.
    const frame = encodeTickFrame(0, 0, 0, [recTick('far', { position: { x: 5000, y: -5000, z: 0 } })]);
    const d = decodeTickFrame(frame)!;
    expect(d.updates[0]!.position.x).toBeCloseTo(5000, 1);
    expect(d.updates[0]!.position.y).toBeCloseTo(-5000, 1);
  });

  it('surfaces sheep only when non-zero', (): void => {
    const frame = encodeTickFrame(0, 0, 0, [
      recTick('sheepy', { sheep: 42 }),
      recTick('nosheep', { sheep: 0 }),
    ]);
    const d = decodeTickFrame(frame)!;
    expect(d.updates[0]!.sheep).toBe(42);
    expect(d.updates[1]!.sheep).toBeUndefined();
  });
});

describe('v3 wireId frames', (): void => {

  it('resolves wireIds through the roster', (): void => {
    const recs = [
      encodeTickPlayerV3(7, { playerId: '', position: { x: 1, y: 2, z: 3 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 100, isDead: false, ski: 0 }),
      encodeTickPlayerV3(9, { playerId: '', position: { x: 4, y: 5, z: 6 }, rotation: { yaw: 1, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 200, isDead: true, ski: 1 }),
    ];
    const r = mkRoster();
    const d = decodeTickFrame(encodeTickFrame(1, 2, 3, recs, WIRE_TICK_V3), r.pool)!;
    expect(d.updates[0]!.wireId).toBe(7);
    expect(d.updates[0]!.playerId).toBe('player_seven');
    expect(d.updates[0]!.position.z).toBeCloseTo(3);
    expect(d.updates[1]!.playerId).toBe('player_nine');
    expect(d.updates[1]!.isDead).toBe(true);
  });

  it('decodes unresolved ids as empty playerId', (): void => {
    const r = mkRoster();
    const d = decodeTickFrame(encodeTickFrame(0, 0, 0, [
      encodeTickPlayerV3(55, { playerId: '', position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 0, isDead: false, ski: 0 }),
    ], WIRE_TICK_V3), r.pool)!;
    expect(d.updates[0]!.wireId).toBe(55);
    expect(d.updates[0]!.playerId).toBe('');
  });

  it('gameState feed replaces the roster wholesale', (): void => {
    const r = mkRoster();
    r.feed({ type: 'gameState', wireIds: { 1: 'fresh_one' } });
    expect(r.ids.get(7)).toBeUndefined();
    expect(r.ids.get(1)).toBe('fresh_one');
  });
});

describe('v4 delta-masked records', (): void => {

  it('unchanged groups mask out; decode inherits the retained values', (): void => {
    const r = new WireIdRoster();
    r.feed({ type: 'wireIds', add: { 7: 'player_seven' } });
    const enc = tickEncodeScratch();
    const last = v4Last();
    const p = baseTickP();
    // First encode is always full (fresh slot).
    const full = encodeTickPlayerV4(7, p, enc, last, false);
    expect(full.length).toBe(30);
    const d1 = decodeTickFrame(encodeTickFrame(0, 1, 0, [full], WIRE_TICK_V4), r.pool)!;
    expect(d1.updates[0]!.velocity.x).toBeCloseTo(10);
    expect(d1.updates[0]!.health).toBe(100);
    // Only position moves → record is mask + pos = 15B, and the decode
    // still reports the retained velocity/health.
    p.position.x = 2;
    const delta = encodeTickPlayerV4(7, p, enc, last, false);
    expect(delta.length).toBe(15);
    const d2 = decodeTickFrame(encodeTickFrame(0, 2, 0, [delta], WIRE_TICK_V4), r.pool)!;
    expect(d2.updates[0]!.position.x).toBeCloseTo(2);
    expect(d2.updates[0]!.velocity.x).toBeCloseTo(10);
    expect(d2.updates[0]!.health).toBe(100);
    expect(d2.updates[0]!.sheep).toBe(40);
  });

  it('a changed field rides the wire even when others mask out', (): void => {
    const r = new WireIdRoster();
    r.feed({ type: 'wireIds', add: { 7: 'player_seven' } });
    const enc = tickEncodeScratch();
    const last = v4Last();
    const p = baseTickP();
    encodeTickPlayerV4(7, p, enc, last, false);
    p.health = 30; // took damage between ticks — must surface on the wire
    const delta = encodeTickPlayerV4(7, p, enc, last, false);
    expect(delta.length).toBe(15 + 3); // mask+pos + hpPing group
    const d = decodeTickFrame(encodeTickFrame(0, 2, 0, [delta], WIRE_TICK_V4), r.pool)!;
    expect(d.updates[0]!.health).toBe(30);
  });

  it('wireId reuse forces a full record — no field inheritance across players', (): void => {
    const enc = tickEncodeScratch();
    const last = v4Last();
    encodeTickPlayerV4(7, baseTickP(), enc, last, false);
    // Slot's wireId was 7; a new player reusing the slot with wireId 9
    // must encode all groups or the decoder inherits the old owner's
    // fields.
    const rec = encodeTickPlayerV4(9, baseTickP(), enc, last, false);
    expect(rec.length).toBe(30);
  });

  it('a single lost frame self-heals — the K-deep basis resends the field', (): void => {
    const r = new WireIdRoster();
    r.feed({ type: 'wireIds', add: { 7: 'player_seven' } });
    const enc = tickEncodeScratch();
    const last = v4Last();
    const p = baseTickP();
    decodeTickFrame(encodeTickFrame(0, 1, 0, [encodeTickPlayerV4(7, p, enc, last, false)], WIRE_TICK_V4), r.pool);
    // Health changes on a frame the link "loses" (never decoded) — but
    // the K-basis keeps carrying it for the next V4_BASIS_DEPTH-1 ticks.
    p.health = 12;
    const lost = encodeTickPlayerV4(7, p, enc, last, false);
    expect(lost.length).toBe(15 + 3); // hp group present
    p.position.x = 5;
    const resent = encodeTickPlayerV4(7, p, enc, last, false);
    expect(resent.length).toBe(15 + 3); // still carrying hp (basis predates the change)
    const healed = decodeTickFrame(encodeTickFrame(0, 3, 0, [resent], WIRE_TICK_V4), r.pool)!;
    expect(healed.updates[0]!.health).toBe(12);
  });

  it('a torn-then-healed link resyncs on the forced full record', (): void => {
    const r = new WireIdRoster();
    r.feed({ type: 'wireIds', add: { 7: 'player_seven' } });
    const enc = tickEncodeScratch();
    const last = v4Last();
    const p = baseTickP();
    decodeTickFrame(encodeTickFrame(0, 1, 0, [encodeTickPlayerV4(7, p, enc, last, false)], WIRE_TICK_V4), r.pool);
    // A burst loss longer than the basis window eats the field: health
    // changes at t2 and frames t2..t4 all die (each carried hp), so the
    // decode pool stays stale until the forced full lands.
    p.health = 12;
    for (let t = 2; t <= 4; t += 1) { p.position.x = t; encodeTickPlayerV4(7, p, enc, last, false); }
    p.position.x = 5;
    const stale = decodeTickFrame(encodeTickFrame(0, 5, 0, [encodeTickPlayerV4(7, p, enc, last, false)], WIRE_TICK_V4), r.pool)!;
    expect(stale.updates[0]!.health).toBe(100);
    const healed = decodeTickFrame(encodeTickFrame(0, 6, 0, [encodeTickPlayerV4(7, p, enc, last, true)], WIRE_TICK_V4), r.pool)!;
    expect(healed.updates[0]!.health).toBe(12);
  });

  it('a truncated frame evicts the baselines it touched — degrades to a lost frame, heals on the next full', (): void => {
    // Two-player frame truncated mid-second-record: before the fix the
    // first record's partially-applied decode stayed in byId, so every
    // later delta inherited poisoned state. Now a failed frame rolls the
    // touched baselines out — deltas drop (no baseline) until the full.
    const r = new WireIdRoster();
    r.feed({ type: 'wireIds', add: { 7: 'player_seven', 9: 'player_nine' } });
    const enc = tickEncodeScratch();
    // One basis ring per record slot — same as production; sharing one
    // across wireIds would force fulls by wireId mismatch.
    const last7 = v4Last();
    const last9 = v4Last();
    const p7 = baseTickP();
    const p9 = { ...baseTickP(), position: { x: 9, y: 9, z: 9 } };
    // NOTE: scratch-encoded records share enc's buffer — copy each
    // before the next encode or it gets overwritten.
    const rec7 = encodeTickPlayerV4(7, p7, enc, last7, false).slice();
    const rec9 = encodeTickPlayerV4(9, p9, enc, last9, false).slice();
    decodeTickFrame(encodeTickFrame(0, 1, 0, [rec7, rec9], WIRE_TICK_V4), r.pool);
    expect(r.pool.byId!.has(7)).toBe(true);
    // Truncate inside the second record — both are 15B deltas now, so
    // 15+15+10 lands mid-way through rec9's groups.
    const torn = encodeTickFrame(0, 2, 0, [
      encodeTickPlayerV4(7, p7, enc, last7, false).slice(),
      encodeTickPlayerV4(9, p9, enc, last9, false).slice(),
    ], WIRE_TICK_V4).slice(0, 15 + 15 + 10);
    expect(decodeTickFrame(torn, r.pool)).toBeNull();
    expect(r.pool.byId!.has(7)).toBe(false); // evicted — half-applied poison gone
    expect(r.pool.byId!.has(9)).toBe(true);  // frame died before touching it — still valid
    // A post-loss delta has nothing to inherit from → drops via the
    // empty-id convention, exactly like a dropped frame.
    p7.position.x = 3;
    const delta = encodeTickPlayerV4(7, p7, enc, last7, false);
    const d = decodeTickFrame(encodeTickFrame(0, 3, 0, [delta], WIRE_TICK_V4), r.pool)!;
    expect(d.updates[0]!.playerId).toBe('');
    // Forced full reseats the baseline.
    const full = encodeTickPlayerV4(7, p7, enc, last7, true);
    decodeTickFrame(encodeTickFrame(0, 4, 0, [full], WIRE_TICK_V4), r.pool);
    expect(r.pool.byId!.has(7)).toBe(true);
  });

  it('a masked delta with no decode baseline drops, then the full record seats it', (): void => {
    // Mid-join window: the roster knows wireId 7 but this receiver never
    // decoded a full record for it — inheriting masked groups would read
    // zeros (health=0 ghost) until the next forced-full.
    const r = new WireIdRoster();
    r.feed({ type: 'wireIds', add: { 7: 'player_seven' } });
    const enc = tickEncodeScratch();
    const last = v4Last();
    const p = baseTickP();
    encodeTickPlayerV4(7, p, enc, last, false); // the join burst this client missed
    p.position.x = 2;
    const delta = encodeTickPlayerV4(7, p, enc, last, false);
    expect(delta.length).toBe(15);
    const dropped = decodeTickFrame(encodeTickFrame(0, 2, 0, [delta], WIRE_TICK_V4), r.pool)!;
    expect(dropped.updates[0]!.playerId).toBe(''); // unresolvable → consumer skips
    const full = encodeTickPlayerV4(7, p, enc, last, true);
    const seated = decodeTickFrame(encodeTickFrame(0, 3, 0, [full], WIRE_TICK_V4), r.pool)!;
    expect(seated.updates[0]!.playerId).toBe('player_seven');
    expect(seated.updates[0]!.health).toBe(100);
    // Baseline now exists — the next delta inherits it.
    p.position.x = 4;
    const after = decodeTickFrame(encodeTickFrame(0, 4, 0, [encodeTickPlayerV4(7, p, enc, last, false)], WIRE_TICK_V4), r.pool)!;
    expect(after.updates[0]!.health).toBe(100);
    expect(after.updates[0]!.position.x).toBeCloseTo(4);
  });

  it('sparse far-tier record strips vel/rot — retained values survive, vitals still flow', (): void => {
    const r = new WireIdRoster();
    r.feed({ type: 'wireIds', add: { 7: 'player_seven' } });
    const enc = tickEncodeScratch();
    const sparseEnc = tickEncodeScratch();
    const last = v4Last();
    const p = baseTickP();
    // Seat the baseline with a full, then change EVERY group — the sparse
    // transform must keep hp/flags while vel/rot emit retained.
    decodeTickFrame(encodeTickFrame(0, 1, 0, [encodeTickPlayerV4(7, p, enc, last, false)], WIRE_TICK_V4), r.pool);
    p.position.x = 8; p.velocity.x = 99; p.rotation.yaw = 2.5; p.health = 55; p.sheep = 80;
    const delta = encodeTickPlayerV4(7, p, enc, last, false);
    expect(delta.length).toBe(30); // every group dirty
    const sparse = sparseV4Record(delta, sparseEnc);
    expect(sparse.length).toBe(15 + 3 + 2); // id+mask+pos + hpPing + flagsSheep
    const d = decodeTickFrame(encodeTickFrame(0, 2, 0, [sparse.slice()], WIRE_TICK_V4), r.pool)!;
    const u = d.updates[0]!;
    expect(u.position.x).toBeCloseTo(8);       // pos flows
    expect(u.health).toBe(55);                  // vitals flow
    expect(u.sheep).toBe(80);                   // flags/sheep flow
    expect(u.velocity.x).toBeCloseTo(10);       // retained, not 99
    expect(u.rotation.yaw).toBeCloseTo(0.5);    // retained, not 2.5
    // The K-deep basis still carries hp+flags for the resend window —
    // sparse keeps those (they're the vitals); only vel/rot stay out.
    const carry = sparseV4Record(encodeTickPlayerV4(7, p, enc, last, false), sparseEnc);
    expect(carry.length).toBe(15 + 3 + 2);
    // After the resend window drains (encode past the ring), the floor is
    // the bare 15B pos record.
    encodeTickPlayerV4(7, p, enc, last, false);
    encodeTickPlayerV4(7, p, enc, last, false);
    const bare = sparseV4Record(encodeTickPlayerV4(7, p, enc, last, false), sparseEnc);
    expect(bare.length).toBe(15);
  });
});
