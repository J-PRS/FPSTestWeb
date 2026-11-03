import { describe, it, expect } from 'bun:test';
import { FleetDirectory } from '../src/fleetDir.ts';
import { wallMs } from '../src/wallClock.ts';

function mkDir(n = 2): FleetDirectory {
  const d = new FleetDirectory();
  for (let i = 0; i < n; i++) {d.register(`w${i}`, 8001 + i);}
  return d;
}

describe('fleet directory', () => {
  it('places a room on the least-CCU live worker and pins it for joiners', () => {
    const d = mkDir();
    d.beat('w0', [], 50, wallMs(1000));
    d.beat('w1', [], 10, wallMs(1000));
    expect(d.resolve('alpha', wallMs(1100))?.id).toBe('w1');
    // The pending claim holds until the beat confirms — a simultaneous
    // second joiner must land on the same worker, not split.
    expect(d.resolve('alpha', wallMs(1200))?.id).toBe('w1');
    d.beat('w1', ['alpha'], 12, wallMs(2000));
    // Now the confirmed home wins even over a less-loaded alternative.
    d.beat('w0', [], 0, wallMs(2000));
    expect(d.resolve('alpha', wallMs(2100))?.id).toBe('w1');
  });

  it('a dead worker releases its rooms for re-placement', () => {
    const d = mkDir();
    d.beat('w0', ['alpha'], 30, wallMs(1000));
    d.beat('w1', [], 60, wallMs(1000));
    // w0 goes silent past the stale bound — its rooms re-open.
    d.beat('w1', [], 60, wallMs(20_000));
    const w = d.resolve('alpha', wallMs(20_100));
    expect(w?.id).toBe('w1');
    expect(d.workers.get('w0')?.up).toBe(false);
  });

  it('an expired claim frees the room for better placement', () => {
    const d = mkDir();
    d.beat('w0', [], 10, wallMs(1000));
    d.beat('w1', [], 5, wallMs(1000));
    // Claim lands on w1, but the joiner never arrives and w1 dies.
    d.resolve('beta', wallMs(1100));
    d.beat('w0', [], 90, wallMs(19_000));
    // w1 never beats again — its pending claim must not pin beta to it.
    const w = d.resolve('beta', wallMs(20_000));
    expect(w?.id).toBe('w0');
  });

  it('pending claims weigh like seats — mints spread on a ccu tie', () => {
    const d = mkDir();
    d.beat('w0', [], 0, wallMs(1000));
    d.beat('w1', [], 0, wallMs(1000));
    // Without claim-weighting both mints land on w0 — every fresh room
    // piles onto the first-up worker until its ccu grows.
    expect(d.resolve('alpha', wallMs(1100))?.id).toBe('w0');
    expect(d.resolve('bravo', wallMs(1200))?.id).toBe('w1');
  });

  it('resolve with no room picks the least-CCU live worker', () => {
    const d = mkDir(3);
    d.beat('w0', [], 40, wallMs(1000));
    d.beat('w1', [], 10, wallMs(1000));
    d.beat('w2', [], 25, wallMs(1000));
    expect(d.resolve(undefined, wallMs(1100))?.id).toBe('w1');
  });

  it('returns null when every worker is down', () => {
    const d = mkDir();
    expect(d.resolve('alpha', wallMs(1000))).toBeNull();
    d.beat('w0', [], 5, wallMs(1000));
    d.beat('w1', [], 5, wallMs(1000));
    expect(d.resolve('alpha', wallMs(30_000))).toBeNull();
  });

  it('a room dropping out of the beat frees its home for re-placement', () => {
    const d = mkDir();
    d.beat('w0', ['alpha'], 20, wallMs(1000));
    d.beat('w1', [], 0, wallMs(1000));
    // Room drained/disposed on w0 — next beat omits it, and a new join
    // for the same name re-places on the emptier worker.
    d.beat('w0', [], 18, wallMs(2000));
    d.beat('w1', [], 0, wallMs(2000));
    expect(d.resolve('alpha', wallMs(2100))?.id).toBe('w1');
  });

  it('continued interest refreshes the claim — slow admission stays pinned', () => {
    const d = mkDir();
    d.beat('w0', [], 10, wallMs(1000));
    d.beat('w1', [], 1, wallMs(1000));
    d.resolve('beta', wallMs(1100)); // claim → w1
    // Joiners keep asking inside the TTL — each hit refreshes the pin so
    // a slow join storm can't split the room across workers.
    d.beat('w0', [], 0, wallMs(20_000)); // w0 now emptier
    d.beat('w1', [], 1, wallMs(20_000));
    d.resolve('beta', wallMs(20_100)); // refresh → still w1
    d.beat('w0', [], 0, wallMs(45_000));
    d.beat('w1', [], 1, wallMs(45_000));
    expect(d.resolve('beta', wallMs(45_100))?.id).toBe('w1');
  });

  it('abandoned claims are garbage-collected — the map cannot grow unbounded', () => {
    const d = mkDir();
    d.beat('w0', [], 0, wallMs(1000));
    for (let i = 0; i < 500; i++) {d.resolve(`spam-${i}`, wallMs(1100));}
    // Past the TTL, one sweep frees every dead claim — a name flood is
    // a memory event only while the names are live.
    d.sweep(wallMs(100_000));
    expect(d.roomNames().size).toBe(0);
  });

  it('draining workers are skipped for placement but keep named homes', () => {
    const d = mkDir();
    d.beat('w0', ['alpha'], 5, wallMs(1000));
    d.beat('w1', [], 10, wallMs(1000));
    // w0 arms the drain - new placement must not send joiners to a
    // worker that refuses them, even though it is emptier.
    d.beat('w0', ['alpha'], 5, wallMs(2000), undefined, true);
    expect(d.resolve('bravo', wallMs(2100))?.id).toBe('w1');
    expect(d.resolve(undefined, wallMs(2100))?.id).toBe('w1');
    // A confirmed room still routes home - the honest 'Server draining'
    // close beats a misleading redirect to a room that isn't there.
    expect(d.resolve('alpha', wallMs(2100))?.id).toBe('w0');
    // Full drain -> null, /join answers 503.
    d.beat('w1', [], 10, wallMs(3000), undefined, true);
    expect(d.resolve('charlie', wallMs(3100))).toBeNull();
    // Drain cleared on a later beat -> placement resumes.
    d.beat('w0', [], 5, wallMs(4000));
    expect(d.resolve('charlie', wallMs(4100))?.id).toBe('w0');
  });

  it('roomNames() covers claims + confirmed homes for mint dedup', () => {
    const d = mkDir();
    d.beat('w0', ['arena-1'], 5, wallMs(1000));
    d.resolve('arena-3', wallMs(1100)); // pending claim
    const names = d.roomNames();
    expect(names.has('arena-1')).toBe(true);
    expect(names.has('arena-3')).toBe(true);
    expect(names.has('arena-2')).toBe(false);
  });
});
