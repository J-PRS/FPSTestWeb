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
    d.beat('w0', [], 50, wallMs(1_000));
    d.beat('w1', [], 10, wallMs(1_000));
    expect(d.resolve('alpha', wallMs(1_100))?.id).toBe('w1');
    // The pending claim holds until the beat confirms — a simultaneous
    // second joiner must land on the same worker, not split.
    expect(d.resolve('alpha', wallMs(1_200))?.id).toBe('w1');
    d.beat('w1', ['alpha'], 12, wallMs(2_000));
    // Now the confirmed home wins even over a less-loaded alternative.
    d.beat('w0', [], 0, wallMs(2_000));
    expect(d.resolve('alpha', wallMs(2_100))?.id).toBe('w1');
  });

  it('a dead worker releases its rooms for re-placement', () => {
    const d = mkDir();
    d.beat('w0', ['alpha'], 30, wallMs(1_000));
    d.beat('w1', [], 60, wallMs(1_000));
    // w0 goes silent past the stale bound — its rooms re-open.
    d.beat('w1', [], 60, wallMs(20_000));
    const w = d.resolve('alpha', wallMs(20_100));
    expect(w?.id).toBe('w1');
    expect(d.workers.get('w0')?.up).toBe(false);
  });

  it('an expired claim frees the room for better placement', () => {
    const d = mkDir();
    d.beat('w0', [], 10, wallMs(1_000));
    d.beat('w1', [], 5, wallMs(1_000));
    // Claim lands on w1, but the joiner never arrives and w1 dies.
    d.resolve('beta', wallMs(1_100));
    d.beat('w0', [], 90, wallMs(19_000));
    // w1 never beats again — its pending claim must not pin beta to it.
    const w = d.resolve('beta', wallMs(20_000));
    expect(w?.id).toBe('w0');
  });

  it('resolve with no room picks the least-CCU live worker', () => {
    const d = mkDir(3);
    d.beat('w0', [], 40, wallMs(1_000));
    d.beat('w1', [], 10, wallMs(1_000));
    d.beat('w2', [], 25, wallMs(1_000));
    expect(d.resolve(undefined, wallMs(1_100))?.id).toBe('w1');
  });

  it('returns null when every worker is down', () => {
    const d = mkDir();
    expect(d.resolve('alpha', wallMs(1_000))).toBeNull();
    d.beat('w0', [], 5, wallMs(1_000));
    d.beat('w1', [], 5, wallMs(1_000));
    expect(d.resolve('alpha', wallMs(30_000))).toBeNull();
  });

  it('a room dropping out of the beat frees its home for re-placement', () => {
    const d = mkDir();
    d.beat('w0', ['alpha'], 20, wallMs(1_000));
    d.beat('w1', [], 0, wallMs(1_000));
    // Room drained/disposed on w0 — next beat omits it, and a new join
    // for the same name re-places on the emptier worker.
    d.beat('w0', [], 18, wallMs(2_000));
    d.beat('w1', [], 0, wallMs(2_000));
    expect(d.resolve('alpha', wallMs(2_100))?.id).toBe('w1');
  });
});
