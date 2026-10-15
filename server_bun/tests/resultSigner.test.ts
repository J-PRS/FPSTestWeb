import { describe, it, expect } from 'bun:test';
import { ResultSigner, type MatchRecord } from '../src/resultSigner.ts';
import { verifyToken, canonicalTokenBytes } from '../../shared/resultToken.ts';
import type { RoomEvent } from '../src/roomEvents.ts';

// The leaderboard receipt: same match events must mint a verifiable
// token, tampering must fail, and the chain must reset between matches.

const KEY = 'test-secret';
const rec: MatchRecord = {
  room: 'arena-0', mode: 'ctf', winner: 'alpha',
  scores: { alpha: 3, bravo: 1 },
  players: [{ id: 'p1', team: 'alpha', kills: 7, deaths: 2 }, { id: 'p2', team: 'bravo', kills: 3, deaths: 5 }],
};

const knock = (force = 20): RoomEvent => ({ type: 'knock', pos: { x: 1, y: 2, z: 3 }, radius: 8, force, kind: 'prey' });

describe('ResultSigner', () => {
  it('mints a signed token that verifies under the same key', async () => {
    const s = new ResultSigner(KEY, () => 'm-1');
    s.feed(knock());
    s.feed(knock(45));
    const token = await s.mint(rec, 'crossfire');
    expect(token.sig).not.toBeNull();
    expect(token.eventHash).toMatch(/^2:[0-9a-f]{8}$/);
    expect(await verifyToken(token, KEY)).toBe(true);
  });

  it('rejects the same token under a different key', async () => {
    const s = new ResultSigner(KEY, () => 'm-2');
    const token = await s.mint(rec);
    expect(await verifyToken(token, 'wrong-key')).toBe(false);
  });

  it('rejects a tampered payload', async () => {
    const s = new ResultSigner(KEY, () => 'm-3');
    const token = await s.mint(rec);
    const forged = { ...token, winner: 'bravo' };
    expect(await verifyToken(forged, KEY)).toBe(false);
  });

  it('identical event streams produce identical hashes', async () => {
    // Pin BOTH clocks: the event stamps and the signed endedAtMs. Before
    // this pinned, the two mints raced wall clock — the full-suite red
    // was two mints a millisecond apart, not a hash bug.
    const a = new ResultSigner(KEY, () => 'm-same');
    const b = new ResultSigner(KEY, () => 'm-same');
    for (const s of [a, b]) { s.feed(knock(), 1_000_000); s.feed(knock(45), 1_000_000); }
    const [ta, tb] = await Promise.all([a.mint(rec, undefined, 2_000_000), b.mint(rec, undefined, 2_000_000)]);
    expect(ta.eventHash).toBe(tb.eventHash);
    expect(ta.sig).toBe(tb.sig); // same canonical bytes, same key → same sig
  });

  it('different event streams diverge the hash', async () => {
    const a = new ResultSigner(KEY, () => 'm-a');
    const b = new ResultSigner(KEY, () => 'm-b');
    a.feed(knock(20));
    b.feed(knock(21));
    const [ta, tb] = await Promise.all([a.mint(rec), b.mint(rec)]);
    expect(ta.eventHash).not.toBe(tb.eventHash);
  });

  it('resets the chain after mint — the next match starts empty', async () => {
    const s = new ResultSigner(KEY, () => 'm-4');
    s.feed(knock());
    const t1 = await s.mint(rec);
    const t2 = await s.mint(rec);
    expect(t2.eventHash).toBe(`0:${  (0x811C9DC5 >>> 0).toString(16).padStart(8, '0')}`);
    expect(t1.eventHash).not.toBe(t2.eventHash);
  });

  it('unsigned dev mode emits sig:null that fails verification', async () => {
    const s = new ResultSigner(null, () => 'm-5');
    const token = await s.mint(rec);
    expect(token.sig).toBeNull();
    expect(await verifyToken(token, KEY)).toBe(false);
  });

  it('canonical bytes are field-order stable', () => {
    const base = { v: 1 as const, matchId: 'm', room: 'r', mode: 'ctf', endedAtMs: 1, winner: 'a', scores: { b: 1, a: 2 }, players: [], eventHash: '0:00' };
    const shuffled = { ...base, scores: { a: 2, b: 1 } };
    expect(canonicalTokenBytes(shuffled)).toBe(canonicalTokenBytes(base));
  });
});
