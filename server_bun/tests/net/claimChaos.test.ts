/**
 * Claim-ledger chaos — the exactly-once claim contract under unordered,
 * lossy, duplicated transports. A shot's spawn nonce, its hit claim, and
 * its blast claim can arrive in ANY order (or twice); the ledger's
 * invariants are what stand between "every hit lands once" and
 * double-kills or silently eaten splash.
 */

import { describe, it, expect } from 'bun:test';
import { ClaimLedger } from '../../src/claimLedger.ts';

const V = { x: 0, y: 0, z: 0 };

describe('netcode chaos: claim ledger', () => {
  it('retransmitted spawn (dup packet) registers once — no phantom twin', () => {
    const l = new ClaimLedger();
    const a = l.register('p', 1, V, V, 'shot-7');
    const b = l.register('p', 1, V, V, 'shot-7');
    expect(a).toBe(b);
    // A second claim on the same nonce must see ONE shell, not two.
    expect(l.resolve('p', { claim: 'shot', clientShotId: 'shot-7' })).toBeTruthy();
    expect(l.resolve('p', { claim: 'shot', clientShotId: 'shot-7' })).toBeUndefined();
  });

  it('re-registering a spent nonce binds the tombstone — no twin mint', () => {
    const l = new ClaimLedger();
    const id = l.register('p', 1, V, V, 'shot-9');
    l.resolve('p', { claim: 'shot', projectileId: id });
    const again = l.register('p', 1, V, V, 'shot-9');
    expect(again).toBe(id);
    // The tombstone's remaining kind still resolves — the aoe half of
    // a rocket survives the direct-hit claim.
    expect(l.resolve('p', { claim: 'aoe', projectileId: id })).toBeTruthy();
  });

  it('one claim per kind per shell — no double-dipping', () => {
    const l = new ClaimLedger();
    const id = l.register('p', 1, V, V);
    l.destroy(id); // destroy ack lands first on the unordered lane
    expect(l.resolve('p', { claim: 'shot', projectileId: id })).toBeTruthy();
    expect(l.resolve('p', { claim: 'aoe', projectileId: id })).toBeTruthy();
    // Both kinds spent — a third claim MUST bounce.
    expect(l.resolve('p', { claim: 'shot', projectileId: id })).toBeUndefined();
    expect(l.resolve('p', { claim: 'aoe', projectileId: id })).toBeUndefined();
  });

  it('a named claim that outraced its spawn defers — never mis-binds a sibling', () => {
    const l = new ClaimLedger();
    // Two live shells in flight; a claim naming a THIRD nonce arrives
    // before that spawn (reordering). It must NOT eat a sibling.
    l.register('p', 1, V, V, 'shot-1');
    l.register('p', 1, V, V, 'shot-2');
    const stolen = l.resolve('p', { claim: 'shot', clientShotId: 'shot-3' });
    expect(stolen).toBeUndefined();
    // Siblings untouched.
    expect(l.resolve('p', { claim: 'shot', clientShotId: 'shot-1' })).toBeTruthy();
    expect(l.resolve('p', { claim: 'shot', clientShotId: 'shot-2' })).toBeTruthy();
  });

  it('destroy-before-claims (unordered) still resolves both claim kinds', () => {
    const l = new ClaimLedger();
    const id = l.register('p', 1, V, V, 'shot-5');
    l.destroy(id);
    // The WT datagram lane reorders: projectileDestroyed lands before
    // the shot/aoe claims it pairs with.
    expect(l.resolve('p', { claim: 'aoe', projectileId: id })).toBeTruthy();
    expect(l.resolve('p', { claim: 'shot', projectileId: id })).toBeTruthy();
  });

  it('claims can never bind another player\'s shell', () => {
    const l = new ClaimLedger();
    const id = l.register('alice', 1, V, V);
    expect(l.resolve('mallory', { claim: 'shot', projectileId: id })).toBeUndefined();
    expect(l.resolve('mallory', { claim: 'shot', weaponType: 1 })).toBeUndefined();
    // Owner's claim still works.
    expect(l.resolve('alice', { claim: 'shot', projectileId: id })).toBeTruthy();
  });

  it('null-id fallback binds the OLDEST shell and tombstones siblings', () => {
    const l = new ClaimLedger();
    l.register('p', 1, V, V);
    l.register('p', 1, V, V);
    l.register('p', 1, V, V);
    // A claim with no id (outraced the echo) resolves the oldest shell
    // and retires ALL live matches — a detonated shell can't mint hits
    // from siblings that happened to share the type.
    expect(l.resolve('p', { claim: 'shot', weaponType: 1 })).toBeTruthy();
    // Each tombstone carries one slot per KIND: later shot claims can
    // only consume the OTHER shells' shot slots — no shell answers twice.
    expect(l.resolve('p', { claim: 'shot', weaponType: 1 })).toBeTruthy();
    expect(l.resolve('p', { claim: 'shot', weaponType: 1 })).toBeTruthy();
    // Three shells, three shot slots — the fourth claim bounces.
    expect(l.resolve('p', { claim: 'shot', weaponType: 1 })).toBeUndefined();
    // Aoe slots are still free on every tombstone.
    expect(l.resolve('p', { claim: 'aoe', weaponType: 1 })).toBeTruthy();
  });
});
