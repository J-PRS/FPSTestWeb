import { describe, it, expect } from 'bun:test';
import { CircularBuffer } from '../../client/src/demo/CircularBuffer.ts';

describe('CircularBuffer', () => {
  it('adds and retrieves items in order', () => {
    const buf = new CircularBuffer<number>(5);
    buf.add(10);
    buf.add(20);
    buf.add(30);
    expect(buf.Count).toBe(3);
    expect(buf.get(0)).toBe(10);
    expect(buf.get(1)).toBe(20);
    expect(buf.get(2)).toBe(30);
  });

  it('overwrites oldest when full', () => {
    const buf = new CircularBuffer<number>(3);
    buf.add(1);
    buf.add(2);
    buf.add(3);
    expect(buf.Count).toBe(3);
    expect(buf.get(0)).toBe(1);

    // Overwrite oldest
    buf.add(4);
    expect(buf.Count).toBe(3);
    expect(buf.get(0)).toBe(2); // 1 was overwritten
    expect(buf.get(1)).toBe(3);
    expect(buf.get(2)).toBe(4);
  });

  it('peeks newest and oldest', () => {
    const buf = new CircularBuffer<string>(3);
    buf.add('a');
    buf.add('b');
    buf.add('c');
    expect(buf.peekOldest()).toBe('a');
    expect(buf.peekNewest()).toBe('c');

    // Wrap around
    buf.add('d');
    expect(buf.peekOldest()).toBe('b');
    expect(buf.peekNewest()).toBe('d');
  });

  it('handles wrap-around multiple times', () => {
    const buf = new CircularBuffer<number>(3);
    for (let i = 0; i < 10; i++) buf.add(i);
    expect(buf.Count).toBe(3);
    expect(buf.get(0)).toBe(7);
    expect(buf.get(1)).toBe(8);
    expect(buf.get(2)).toBe(9);
  });

  it('extracts all items in order', () => {
    const buf = new CircularBuffer<number>(5);
    buf.add(1);
    buf.add(2);
    buf.add(3);
    const all = buf.extractAll();
    expect(all).toEqual([1, 2, 3]);
    expect(buf.Count).toBe(0);
    expect(buf.IsEmpty).toBe(true);
  });

  it('extracts all items after wrap-around', () => {
    const buf = new CircularBuffer<number>(3);
    buf.add(1);
    buf.add(2);
    buf.add(3);
    buf.add(4); // overwrites 1
    buf.add(5); // overwrites 2
    const all = buf.extractAll();
    expect(all).toEqual([3, 4, 5]);
  });

  it('extracts newest N items', () => {
    const buf = new CircularBuffer<number>(5);
    buf.add(1);
    buf.add(2);
    buf.add(3);
    buf.add(4);
    const newest = buf.extractNewest(2);
    expect(newest).toEqual([3, 4]);
  });

  it('clears correctly', () => {
    const buf = new CircularBuffer<number>(5);
    buf.add(1);
    buf.add(2);
    buf.clear();
    expect(buf.Count).toBe(0);
    expect(buf.IsEmpty).toBe(true);
  });

  it('throws on get with out-of-range index', () => {
    const buf = new CircularBuffer<number>(5);
    buf.add(1);
    expect(() => buf.get(-1)).toThrow();
    expect(() => buf.get(1)).toThrow();
  });

  it('throws on peek of empty buffer', () => {
    const buf = new CircularBuffer<number>(5);
    expect(() => buf.peekNewest()).toThrow();
    expect(() => buf.peekOldest()).toThrow();
  });

  it('throws on zero or negative capacity', () => {
    expect(() => new CircularBuffer<number>(0)).toThrow();
    expect(() => new CircularBuffer<number>(-1)).toThrow();
  });

  describe('findIndexAfterTimestamp', () => {
    it('finds first item after timestamp', () => {
      const buf = new CircularBuffer<{ ts: number }>(5);
      buf.add({ ts: 1.0 });
      buf.add({ ts: 2.0 });
      buf.add({ ts: 3.0 });
      buf.add({ ts: 4.0 });
      const idx = buf.findIndexAfterTimestamp(2.5, item => item.ts);
      expect(idx).toBe(2); // item with ts=3.0
    });

    it('returns 0 if all items are after timestamp', () => {
      const buf = new CircularBuffer<{ ts: number }>(5);
      buf.add({ ts: 1.0 });
      buf.add({ ts: 2.0 });
      const idx = buf.findIndexAfterTimestamp(0.5, item => item.ts);
      expect(idx).toBe(0);
    });

    it('returns -1 if no items are after timestamp', () => {
      const buf = new CircularBuffer<{ ts: number }>(5);
      buf.add({ ts: 1.0 });
      buf.add({ ts: 2.0 });
      const idx = buf.findIndexAfterTimestamp(5.0, item => item.ts);
      expect(idx).toBe(-1);
    });

    it('returns -1 on empty buffer', () => {
      const buf = new CircularBuffer<{ ts: number }>(5);
      const idx = buf.findIndexAfterTimestamp(1.0, item => item.ts);
      expect(idx).toBe(-1);
    });

    it('works after wrap-around', () => {
      const buf = new CircularBuffer<{ ts: number }>(3);
      buf.add({ ts: 1.0 });
      buf.add({ ts: 2.0 });
      buf.add({ ts: 3.0 });
      buf.add({ ts: 4.0 }); // overwrites ts=1.0
      buf.add({ ts: 5.0 }); // overwrites ts=2.0
      // Buffer now: [ts=3.0, ts=4.0, ts=5.0]
      const idx = buf.findIndexAfterTimestamp(3.5, item => item.ts);
      expect(idx).toBe(1); // item with ts=4.0
    });

    it('handles exact match boundary (finds strictly after)', () => {
      const buf = new CircularBuffer<{ ts: number }>(5);
      buf.add({ ts: 1.0 });
      buf.add({ ts: 2.0 });
      buf.add({ ts: 3.0 });
      const idx = buf.findIndexAfterTimestamp(2.0, item => item.ts);
      expect(idx).toBe(2); // strictly > 2.0, so ts=3.0
    });
  });
});
