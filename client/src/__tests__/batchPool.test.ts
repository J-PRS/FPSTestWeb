// Overflow-batch contract: grow sibling batches on demand, retire drained
// overflow back to the batch[0] floor. Every batched FX pool shares these
// two functions — a regression here silently starves or leaks render slots
// (the exact bug class that froze ribbon trails midair).
import { describe, it, expect } from 'vitest';
import { acquireBatch, retireBatch, type BatchMap } from '../core/batchPool.js';

interface FakeBatch { id: number; used: number; cap: number; disposed: boolean }

function fixture() {
  const map: BatchMap<string, FakeBatch> = new Map();
  let next = 0;
  const make = (_key: string): FakeBatch => ({ id: next++, used: 0, cap: 2, disposed: false });
  const hasRoom = (b: FakeBatch) => b.used < b.cap;
  const isDrained = (b: FakeBatch) => b.used === 0;
  const dispose = (b: FakeBatch) => { b.disposed = true; };
  const alloc = (key = 'scene'): FakeBatch => {
    const b = acquireBatch(map, key, make, hasRoom);
    b.used++;
    return b;
  };
  const free = (key: string, b: FakeBatch) => {
    b.used--;
    retireBatch(map, key, b, isDrained, dispose);
  };
  return { map, alloc, free };
}

describe('batchPool', () => {
  it('reuses the same batch while it has room', () => {
    const { map, alloc } = fixture();
    const a = alloc(), b = alloc();
    expect(a).toBe(b);
    expect(map.get('scene')!.length).toBe(1);
  });

  it('spawns a sibling batch on overflow instead of starving', () => {
    const { map, alloc } = fixture();
    const a = alloc(), alloc2 = alloc();
    const c = alloc(); // first batch full (cap 2) — sibling required
    expect(c).not.toBe(a);
    expect(map.get('scene')!.length).toBe(2);
    expect(alloc2).toBe(a);
  });

  it('refills freed slots in an earlier batch before growing further', () => {
    const { map, alloc, free } = fixture();
    const a = alloc(), alloc2 = alloc(), c = alloc();
    free('scene', a); // batch 0 now has room
    const d = alloc();
    expect(d).toBe(a); // earlier batch wins over a new sibling
    expect(map.get('scene')!.length).toBe(2);
    expect(c).not.toBe(d);
  });

  it('retires a fully drained overflow batch and disposes it', () => {
    const { map, alloc, free } = fixture();
    const a = alloc(), alloc2 = alloc(), c = alloc();
    free('scene', c);
    expect(c.disposed).toBe(true);
    expect(map.get('scene')!.length).toBe(1);
    expect(a.disposed).toBe(false);
  });

  it('never retires the floor batch even when empty', () => {
    const { map, alloc, free } = fixture();
    const a = alloc();
    free('scene', a);
    expect(a.disposed).toBe(false);
    expect(map.get('scene')!.length).toBe(1);
  });

  it('keeps a partially drained overflow batch alive', () => {
    const { map, alloc, free } = fixture();
    const allocA = alloc(), alloc2 = alloc(), c = alloc();
    alloc('scene'); // put a second occupant in c's batch
    free('scene', c); // batch still has one used slot
    expect(c.disposed).toBe(false);
    expect(map.get('scene')!.length).toBe(2);
    expect(allocA).toBeTruthy(); expect(alloc2).toBeTruthy();
  });

  it('ignores retireBatch for an unregistered batch', () => {
    const { map, alloc, free } = fixture();
    alloc(); // batch 0 exists but the stray isn't in the list
    const stray = { id: 99, used: 0, cap: 2, disposed: false };
    free('scene', stray);
    expect(stray.disposed).toBe(false);
    expect(map.get('scene')!.length).toBe(1);
  });

  it('tracks batches per key independently', () => {
    const { map, alloc } = fixture();
    alloc('sceneA');
    alloc('sceneB');
    expect(map.get('sceneA')!.length).toBe(1);
    expect(map.get('sceneB')!.length).toBe(1);
  });
});
