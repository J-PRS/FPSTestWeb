import { describe, it, expect } from 'vitest';
import {
  encodePosition, decodePosition, encodeInputMove, decodeInputMove,
  encodeWireJson, decodeWireJson,
  encodeTickPlayer, encodeTickPlayerV3, encodeTickFrame, decodeTickFrame,
  WIRE_TICK, WIRE_TICK_V3, tickEncodeScratch,
  encodeBallSegment, encodeBallBatch, decodeBallSegment, decodeBallBatch, decodeBallAny,
  encodePosClaim, decodePosClaim, encodeShot, decodeShot, encodeHit, decodeHit,
  encodeWidPos, decodeWidPos, encodeShotEv, decodeShotEv,
  encodeKnock, decodeKnock, encodeKill, decodeKill,
  encodeProjSpawn, decodeProjSpawn, encodeProjGone, decodeProjGone,
} from '../../../shared/wire';

// Malformed-input contract for every binary codec: decoders sit on the
// hostile boundary (public server, P2P peers, WAN corruption). They must
// NEVER throw and must NEVER hand a non-finite number to a sim - the
// wire.ts header calls NaN "the poison" and decodePosition already gates
// it; this suite makes that contract universal across all ~20 codecs.

const V = { x: 1.5, y: -2.25, z: 3.75 };
const V2 = { x: -4, y: 5.5, z: -6.5 };

interface Codec {
  name: string;
  frame: Uint8Array;
  decode: (u8: Uint8Array) => unknown;
}

const CODECS: Codec[] = [
  {
    name: 'position',
    frame: encodePosition(V, { yaw: 1.2, pitch: -0.4 }, V2, 42, 55, 7,
      { forward: 1, right: -1, jump: 1, ski: 0, jet: 1 }),
    decode: decodePosition,
  },
  {
    name: 'inputMove',
    frame: encodeInputMove(9, { forward: 1, right: -1, jump: 1, ski: 0, jet: 1 }),
    decode: decodeInputMove,
  },
  {
    name: 'wireJson',
    frame: encodeWireJson('{"type":"ping","n":1}'),
    decode: (u8) => decodeWireJson(u8),
  },
  {
    name: 'tickV2',
    frame: encodeTickFrame(1, 2, 3, [encodeTickPlayer({
      playerId: 'p1', position: V, rotation: { yaw: 0.5, pitch: 0.1 },
      velocity: V2, health: 100, isDead: false, ski: 1, jet: 0, status: 0,
    })], WIRE_TICK),
    decode: (u8) => decodeTickFrame(u8),
  },
  {
    name: 'tickV3',
    frame: encodeTickFrame(1, 2, 3, [encodeTickPlayerV3(7, {
      playerId: '', position: V, rotation: { yaw: 0.5, pitch: 0.1 },
      velocity: V2, health: 100, isDead: false, ski: 1, jet: 0, status: 0,
    }, tickEncodeScratch())], WIRE_TICK_V3),
    decode: (u8) => decodeTickFrame(u8),
  },
  {
    name: 'ballSeg',
    frame: encodeBallSegment({
      id: 5, kind: 'rock', position: V, velocity: V2, enraged: true,
      targetId: 'player_x', tp: V, et: 12.5, slowT: 0.3, damp: true, t: 1234.5,
    }),
    decode: decodeBallSegment,
  },
  {
    name: 'ballBatch',
    frame: encodeBallBatch([
      encodeBallSegment({ id: 1, kind: 'rock', position: V, velocity: V2, enraged: false, targetId: null, tp: null, et: 1, slowT: 0, damp: false, t: 1 }),
      encodeBallSegment({ id: 2, kind: 'brush', position: V2, velocity: V, enraged: true, targetId: 'b', tp: V, et: 2, slowT: 1, damp: true, t: 2 }),
    ]),
    decode: decodeBallBatch,
  },
  {
    name: 'ballAny',
    frame: encodeBallBatch([
      encodeBallSegment({ id: 3, kind: 'goo', position: V, velocity: V2, enraged: false, targetId: null, tp: null, et: 0, slowT: 0, damp: false, t: 3 }),
    ]),
    decode: decodeBallAny,
  },
  {
    name: 'posClaim',
    frame: encodePosClaim(2, V),
    decode: (u8) => decodePosClaim(u8, 2),
  },
  {
    name: 'shot',
    frame: encodeShot({ weaponType: 5, pos: V, dir: V2, shotId: 's1', fireAt: 1234 }),
    decode: decodeShot,
  },
  {
    name: 'hit',
    frame: encodeHit({ targetWid: 3, shooterWid: 7, damage: 25, health: 80, armor: 10, seq: 5, shotId: 'abc', gd: 1.5 }),
    decode: decodeHit,
  },
  {
    name: 'widPos',
    frame: encodeWidPos(2, 9, V, 7),
    decode: (u8) => decodeWidPos(u8, 2),
  },
  {
    name: 'shotEv',
    frame: encodeShotEv(4, 5, V, V2),
    decode: decodeShotEv,
  },
  {
    name: 'knock',
    frame: encodeKnock(4, V, 12.5, true, false),
    decode: decodeKnock,
  },
  {
    name: 'kill',
    frame: encodeKill({ shooterWid: 3, targetWid: 9, weapon: 5, streak: 2, air: 1.2, steal: true }),
    decode: decodeKill,
  },
  {
    name: 'projSpawn',
    frame: encodeProjSpawn({
      projId: 11, ownerWireId: 4, weaponType: 5, pellet: 2, age: 0.1, t: 999,
      position: V, velocity: V2, shotId: 'shot1',
    }),
    decode: decodeProjSpawn,
  },
  {
    name: 'projGone',
    frame: encodeProjGone({ projId: 11, age: 0.2, position: V, shotId: 'shot1' }),
    decode: decodeProjGone,
  },
];

// mulberry32 - deterministic fuzz; a flaky decode must reproduce.
// oxlint-disable unicorn/prefer-math-trunc -- >>> 0 is a uint32 wrap, Math.trunc is not equivalent
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D_2B_79_F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
// oxlint-enable unicorn/prefer-math-trunc

const rand = rng(0xC0_FF_EE);

function finiteDeep(v: unknown, path = ''): string | null {
  if (typeof v === 'number') {return Number.isFinite(v) ? null : `non-finite at ${path}`;}
  if (v === null || typeof v !== 'object') {return null;}
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const bad = finiteDeep(v[i], `${path}[${i}]`);
      if (bad) {return bad;}
    }
    return null;
  }
  if (v instanceof Uint8Array) {return null;}
  for (const [k, x] of Object.entries(v)) {
    const bad = finiteDeep(x, `${path}.${k}`);
    if (bad) {return bad;}
  }
  return null;
}

/** decode() must not throw; a non-null result must be finite-clean. */
function expectClean(codec: Codec, u8: Uint8Array): void {
  let out: unknown;
  try {
    out = codec.decode(u8);
  } catch (error) {
    throw new Error(`${codec.name} threw on ${u8.length}B input: ${(error as Error).message}`, { cause: error });
  }
  const bad = finiteDeep(out);
  expect(bad, `${codec.name} produced ${bad}`).toBeNull();
}

describe('wire codec fuzz - malformed input contract', () => {
  it('every codec round-trips its own valid frame', () => {
    for (const c of CODECS) {
      const out = c.decode(c.frame);
      expect(out, `${c.name} rejected its own frame`).not.toBeNull();
      expect(finiteDeep(out), `${c.name} emitted non-finite`).toBeNull();
    }
  });

  it('no codec throws or emits non-finite on any truncation', () => {
    expect(CODECS.length).toBeGreaterThan(0);
    for (const c of CODECS) {
      for (let i = 0; i <= c.frame.length; i += 1) {
        expectClean(c, c.frame.subarray(0, i));
      }
    }
  });

  it('no codec throws or emits non-finite on random garbage', () => {
    expect(CODECS.length).toBeGreaterThan(0);
    for (const c of CODECS) {
      for (let i = 0; i < 300; i += 1) {
        const len = Math.floor(rand() * 257);
        const buf = new Uint8Array(len);
        for (let j = 0; j < len; j += 1) {buf[j] = Math.floor(rand() * 256);}
        expectClean(c, buf);
      }
    }
  });

  it('no codec throws or emits non-finite on bit-flipped frames', () => {
    expect(CODECS.length).toBeGreaterThan(0);
    for (const c of CODECS) {
      for (let i = 0; i < 200; i += 1) {
        const buf = c.frame.slice();
        const pos = Math.floor(rand() * buf.length);
        buf[pos] = buf[pos]! ^ (1 << Math.floor(rand() * 8));
        expectClean(c, buf);
      }
    }
  });
});
