import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoStorage } from '../src/DemoStorage.ts';

// parseDemoHeader reads length-prefixed fields from attacker-controlled
// bytes — before bounds checks, a truncated body or lying length field
// threw a bare RangeError (500), and a crafted Infinity lifetime sorted
// itself to the top of the index forever.
describe('DemoStorage header bounds', () => {
  function demoBuffer(lifetime: number, gvLenLie = 0): ArrayBuffer {
    const descBytes = new TextEncoder().encode('shot');
    const gvBytes = new TextEncoder().encode('test');
    const size = 1 + 4 + 2 + gvBytes.length + 8 + 4 + 4 * 4 + 2 + descBytes.length + 32 + 4;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    let o = 0;
    v.setUint8(o++, 0x44);
    v.setInt32(o, 2, true); o += 4;
    v.setUint16(o, gvLenLie || gvBytes.length, true); o += 2;
    new Uint8Array(buf, o, gvBytes.length).set(gvBytes); o += gvBytes.length;
    o += 8;
    v.setFloat32(o, 1.0, true); o += 4;
    o += 16;
    v.setUint16(o, descBytes.length, true); o += 2;
    new Uint8Array(buf, o, descBytes.length).set(descBytes); o += descBytes.length;
    o += 32;
    v.setFloat32(o, lifetime, true);
    return buf;
  }

  it('truncated body rejects as malformed, not RangeError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'demos-hdr-'));
    try {
      const store = new DemoStorage(dir);
      const truncated = demoBuffer(5).slice(0, 6); // magic + partial header
      await expect(store.saveDemo(truncated)).rejects.toThrow('Malformed demo header');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lying length field rejects as malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'demos-hdr-'));
    try {
      const store = new DemoStorage(dir);
      await expect(store.saveDemo(demoBuffer(5, 0xffff))).rejects.toThrow('Malformed demo header');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Infinity lifetime is rejected, not pinned to index top', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'demos-hdr-'));
    try {
      const store = new DemoStorage(dir);
      const meta = await store.saveDemo(demoBuffer(Infinity));
      expect(meta.filename).toBe('');
      const huge = await store.saveDemo(demoBuffer(1e30));
      expect(huge.filename).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
