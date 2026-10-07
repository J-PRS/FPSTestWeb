import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoStorage } from '../src/DemoStorage.ts';

// saveDemo mints `clip_<iso-second>_<lifetime>s.demo` — second precision
// plus 0.1s rounding means same-second uploads with equal air-time used
// to clobber each other (one file, two index rows). The suffix loop must
// rename instead of overwrite.
describe('DemoStorage filename collisions', () => {
  function demoBuffer(lifetime: number, desc = 'shot'): ArrayBuffer {
    const descBytes = new TextEncoder().encode(desc);
    const gvBytes = new TextEncoder().encode('test');
    const size = 1 + 4 + 2 + gvBytes.length + 8 + 4 + 4 * 4 + 2 + descBytes.length + 32 + 4;
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    let o = 0;
    v.setUint8(o++, 0x44);              // magic
    v.setInt32(o, 2, true); o += 4;     // formatVersion v2
    v.setUint16(o, gvBytes.length, true); o += 2;
    new Uint8Array(buf, o, gvBytes.length).set(gvBytes); o += gvBytes.length;
    o += 8;                             // timestamp
    v.setFloat32(o, 1.0, true); o += 4; // duration
    o += 16;                            // totalFrames/proj/target/checksum
    v.setUint16(o, descBytes.length, true); o += 2;
    new Uint8Array(buf, o, descBytes.length).set(descBytes); o += descBytes.length;
    o += 32;                            // start pos/rot/vel
    v.setFloat32(o, lifetime, true);    // projectileLifetime
    return buf;
  }

  it('same-second same-lifetime uploads get distinct filenames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'demos-col-'));
    // Freeze the clock so both saves mint the identical base name —
    // without the suffix loop, save b would overwrite save a's file.
    const RealDate = globalThis.Date;
    class Frozen extends RealDate {
      constructor() { super('2026-10-07T12:00:00.000Z'); }
    }
    globalThis.Date = Frozen as typeof Date;
    try {
      const store = new DemoStorage(dir);
      const a = await store.saveDemo(demoBuffer(9.9, 'first'));
      const b = await store.saveDemo(demoBuffer(9.9, 'second'));
      expect(a.filename).toBe('clip_2026-10-07T12-00-00_9.9s.demo');
      expect(b.filename).toBe('clip_2026-10-07T12-00-00_9.9s_2.demo');
      expect(existsSync(join(dir, a.filename))).toBe(true);
      expect(existsSync(join(dir, b.filename))).toBe(true);
      const list = await store.listDemos();
      expect(list.length).toBe(2);
    } finally {
      globalThis.Date = RealDate;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
