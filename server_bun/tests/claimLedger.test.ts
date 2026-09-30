import { describe, it, expect } from 'bun:test';
import { ClaimLedger, clampPing } from '../src/claimLedger.ts';

// The claim ledger is the legality contract for hit claims: a spawn
// report mints proj_N, each id fuels exactly one `shot` and one
// `aoeShot` claim (a rocket's direct hit AND its blast name the same
// shell), and destroys tombstone so reordered claims still resolve.
const V = { x: 0, y: 0, z: 0 };

describe('ClaimLedger', () => {
  it('register mints unique server ids', () => {
    const l = new ClaimLedger();
    const a = l.register('p1', 0, V, V);
    const b = l.register('p1', 0, V, V);
    expect(a).toBe('proj_1');
    expect(b).toBe('proj_2');
    expect(l.size).toBe(2);
  });

  it('one id fuels one shot claim AND one aoe claim, never two of a kind', () => {
    const l = new ClaimLedger();
    const id = l.register('p1', 0, V, V);
    expect(l.resolve('p1', id, 0, 'shot')).toBeTruthy();
    expect(l.resolve('p1', id, 0, 'aoe')).toBeTruthy(); // paired blast of the same shell
    expect(l.resolve('p1', id, 0, 'shot')).toBeUndefined();
    expect(l.resolve('p1', id, 0, 'aoe')).toBeUndefined();
  });

  it('rejects claims naming another player\'s projectile', () => {
    const l = new ClaimLedger();
    const id = l.register('p1', 0, V, V);
    expect(l.resolve('p2', id, 0, 'shot')).toBeUndefined();
    // p1's shell stays live — the foreign claim didn't consume it.
    expect(l.resolve('p1', id, 0, 'shot')).toBeTruthy();
  });

  it('null-id fallback resolves latest AND tombstones every matching live shell', () => {
    const l = new ClaimLedger();
    const first = l.register('p1', 0, V, V);
    const second = l.register('p1', 0, V, V);
    const hit = l.resolve('p1', null, 0, 'shot');
    expect(hit).toBeTruthy();
    // With an unordered transport the claim could mean either shell —
    // both must be tombstoned or each leftover mints free hits later.
    expect(l.size).toBe(0);
    // Each tombstone still satisfies its own paired claims once.
    expect(l.resolve('p1', first, 0, 'aoe')).toBeTruthy();
    expect(l.resolve('p1', second, 0, 'aoe')).toBeTruthy();
    expect(l.resolve('p1', first, 0, 'aoe')).toBeUndefined();
  });

  it('null-id fallback respects the claimed weapon type', () => {
    const l = new ClaimLedger();
    l.register('p1', 0, V, V); // different type than the claim names
    expect(l.resolve('p1', null, 7, 'shot')).toBeUndefined();
  });

  it('destroy tombstones a live shell so reordered claims still resolve', () => {
    const l = new ClaimLedger();
    const id = l.register('p1', 0, V, V);
    l.destroy(id); // detonation ack lands BEFORE its claims (datagram reorder)
    expect(l.resolve('p1', id, 0, 'shot')).toBeTruthy();
    expect(l.resolve('p1', id, 0, 'aoe')).toBeTruthy();
    expect(l.resolve('p1', id, 0, 'shot')).toBeUndefined();
  });

  it('unknown ids never resolve', () => {
    const l = new ClaimLedger();
    l.register('p1', 0, V, V);
    expect(l.resolve('p1', 'proj_999', 0, 'shot')).toBeUndefined();
  });

  it('ownerOf works on live and spent ids', () => {
    const l = new ClaimLedger();
    const id = l.register('p1', 0, V, V);
    expect(l.ownerOf(id)).toBe('p1');
    l.destroy(id);
    expect(l.ownerOf(id)).toBe('p1'); // spent tombstone still answers
    expect(l.ownerOf('proj_999')).toBeUndefined();
  });

  it('removePlayer drops live and spent records', () => {
    const l = new ClaimLedger();
    const live = l.register('p1', 0, V, V);
    const spent = l.register('p1', 0, V, V);
    l.destroy(spent);
    l.removePlayer('p1');
    expect(l.resolve('p1', live, 0, 'shot')).toBeUndefined();
    expect(l.resolve('p1', spent, 0, 'aoe')).toBeUndefined();
    expect(l.size).toBe(0);
  });

  it('clampPing bounds the rewind window', () => {
    expect(clampPing(-50)).toBe(0);
    expect(clampPing(120)).toBe(120);
    expect(clampPing(60000)).toBe(250); // forged pings can't rewind arbitrarily
  });
});
