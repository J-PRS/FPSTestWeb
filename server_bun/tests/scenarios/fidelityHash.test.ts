import { describe, it, expect } from 'bun:test';
import { computeFlagHash, computePickupHash } from '../../../shared/stateHash.ts';

// §4.7 fidelity hashes — the desync signal is only as good as its
// stability: same roster must hash the same regardless of map order,
// and any mirrored edge field changing must change the hash.
describe('scenario: fidelity hashes (flags + pickups)', () => {
  it('flagHash is order-independent and edge-sensitive', () => {
    const roster = new Map([
      ['alpha', { state: 'home', carrier: null }],
      ['bravo', { state: 'carried', carrier: 'p1' }],
    ]);
    const reversed = new Map([...roster].reverse());
    expect(computeFlagHash(reversed)).toBe(computeFlagHash(roster));

    // Every mirrored edge field perturbs the hash — a grab, a return,
    // a carrier swap must all surface.
    const grabbed = new Map([...roster].map(([t, f]) => [t, { ...f }]));
    grabbed.get('alpha')!.state = 'carried';
    grabbed.get('alpha')!.carrier = 'p2';
    expect(computeFlagHash(grabbed)).not.toBe(computeFlagHash(roster));

    const carrierOnly = new Map([...roster].map(([t, f]) => [t, { ...f }]));
    carrierOnly.get('bravo')!.carrier = 'p9';
    expect(computeFlagHash(carrierOnly)).not.toBe(computeFlagHash(roster));
  });

  it('pickupHash is order-independent and edge-sensitive', () => {
    const roster = new Map<number, { kind: string }>([
      [1, { kind: 'gem' }],
      [2, { kind: 'tag' }],
      [7, { kind: 'armor' }],
    ]);
    const reversed = new Map([...roster].reverse());
    expect(computePickupHash(reversed)).toBe(computePickupHash(roster));

    // A collect edge (id gone) and a spawn edge (new id) both move the hash.
    const collected = new Map(roster);
    collected.delete(2);
    expect(computePickupHash(collected)).not.toBe(computePickupHash(roster));

    const spawned = new Map(roster);
    spawned.set(9, { kind: 'dd' });
    expect(computePickupHash(spawned)).not.toBe(computePickupHash(roster));

    // Same roster, different kind on one id — a re-spawn rest spot that
    // changed kind must not alias.
    const kindChanged = new Map([...roster].map(([id, p]) => [id, { ...p }]));
    kindChanged.get(1)!.kind = 'heal';
    expect(computePickupHash(kindChanged)).not.toBe(computePickupHash(roster));
  });
});
