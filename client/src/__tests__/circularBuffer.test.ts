// Demo ring semantics: wrap-around order, slot reuse for zero-alloc adds,
// range extraction, timestamp search. A quiet off-by-one here silently
// ages the wrong second of gameplay out of the buffer.
import { describe, it, expect } from 'vitest';
import { CircularBuffer } from '../demo/CircularBuffer.js';

describe('CircularBuffer', () => {
  it('wraps and evicts oldest in order', () => {
    const b = new CircularBuffer<number>(3);
    b.add(1); b.add(2); b.add(3); b.add(4); // 1 evicted
    expect(b.Count).toBe(3);
    expect(b.peekOldest()).toBe(2);
    expect(b.peekNewest()).toBe(4);
    expect(b.get(0)).toBe(2);
    expect(b.get(2)).toBe(4);
    expect(() => b.get(3)).toThrow();
  });

  it('slotForNext enables zero-alloc reuse on a full ring', () => {
    const b = new CircularBuffer<{ v: number }>(2);
    b.add({ v: 1 }); b.add({ v: 2 });
    const slot = b.slotForNext();
    const obj = b.rawAt(slot)!;
    obj.v = 3;
    b.add(obj); // same object re-added — ring stores the write, not a copy
    expect(b.peekNewest()).toBe(obj);
    expect(b.peekOldest().v).toBe(2);
  });

  it('extracts ranges and clears', () => {
    const b = new CircularBuffer<number>(5);
    for (let i = 0; i < 4; i++) b.add(i);
    expect(b.extractNewest(2)).toEqual([2, 3]);
    expect(b.extractAll()).toEqual([0, 1, 2, 3]);
    expect(b.IsEmpty).toBe(true);
  });

  it('findIndexAfterTimestamp lands on the first newer item', () => {
    const b = new CircularBuffer<{ t: number }>(8);
    for (const t of [1, 2, 3, 4, 5]) b.add({ t });
    expect(b.findIndexAfterTimestamp(2.5, (x) => x.t)).toBe(2); // {t:3}
    expect(b.findIndexAfterTimestamp(5, (x) => x.t)).toBe(-1);  // nothing newer
    expect(b.findIndexAfterTimestamp(0, (x) => x.t)).toBe(0);
  });
});
