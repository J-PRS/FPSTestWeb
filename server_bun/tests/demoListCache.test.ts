import { describe, it, expect, beforeAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoStorage } from '../src/DemoStorage.ts';
import type { DemoMeta } from '../src/DemoStorage.ts';

// /demos is a public route — the stale-file sweep stats every index
// entry per request. The 5s listing cache bounds that to one sweep per
// window; uploads/evictions invalidate through saveIndex.
describe('DemoStorage listDemos cache', () => {
  let dir: string;
  let store: DemoStorage;
  const peek = () => store as unknown as {
    index: DemoMeta[];
    listCache: { at: number; rows: DemoMeta[] } | null;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'demos-'));
    store = new DemoStorage(dir);
    await new Promise(r => setTimeout(r, 50)); // let loadIndex settle
    writeFileSync(join(dir, 'x.demo'), Buffer.from([0x44]));
    peek().index.push({ filename: 'x.demo', projectileLifetime: 99, timestamp: 0, description: 'd', fileSize: 1 });
  });

  it('serves repeat lists from cache — no per-request stat sweep', async () => {
    const a = await store.listDemos();
    expect(a.length).toBe(1);
    expect(await store.listDemos()).toBe(a);
    // The cached rows are served even after the file vanishes — proof the
    // stat sweep did not run on the second call.
    rmSync(join(dir, 'x.demo'));
    expect(await store.listDemos()).toBe(a);
  });

  it('sweeps stale entries again once the window expires', async () => {
    peek().listCache!.at -= 10_000;
    const rows = await store.listDemos();
    expect(rows.length).toBe(0);
    expect(peek().index.length).toBe(0);
  });

  it('saveIndex invalidates the cache so uploads appear immediately', async () => {
    const a = await store.listDemos();
    expect(a.length).toBe(0);
    writeFileSync(join(dir, 'y.demo'), Buffer.from([0x44]));
    peek().index.push({ filename: 'y.demo', projectileLifetime: 99, timestamp: 0, description: 'd', fileSize: 1 });
    await (store as unknown as { saveIndex(): Promise<void> }).saveIndex();
    expect(peek().listCache).toBeNull();
    expect((await store.listDemos()).length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
