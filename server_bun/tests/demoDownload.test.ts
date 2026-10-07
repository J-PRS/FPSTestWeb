import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoStorage } from '../src/DemoStorage.ts';

// /demos/:file is a public unauthenticated read — loadDemo's filename
// check is the only thing between a request and arbitrary local reads.
// A dropped guard reopens traversal; the .demo suffix alone would still
// leak any *.demo file anywhere on disk via ../ segments.
describe('DemoStorage loadDemo path guard', () => {
  let root: string;
  let dir: string;
  let store: DemoStorage;
  const PAYLOAD = Buffer.from([0x44, 0x45, 0x4d, 0x4f]);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'demodl-'));
    dir = join(root, 'demos');
    store = new DemoStorage(dir);
    await new Promise((r) => setTimeout(r, 50)); // let loadIndex settle
    writeFileSync(join(dir, 'clip.demo'), PAYLOAD);
    // A .demo file OUTSIDE the served dir — traversal must not reach it.
    writeFileSync(join(root, 'outside.demo'), Buffer.from([0xff]));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('serves a real clip by name', async () => {
    const data = await store.loadDemo('clip.demo');
    expect(data).not.toBeNull();
    expect(new Uint8Array(data!)).toEqual(new Uint8Array(PAYLOAD));
  });

  it('refuses traversal — .. and separators never escape the dir', async () => {
    for (const name of ['../outside.demo', '..\\outside.demo', 'a/../../outside.demo',
      '/etc/passwd.demo', 'C:\\outside.demo', 'sub/clip.demo']) {
      expect(await store.loadDemo(name)).toBeNull();
    }
  });

  it('refuses non-.demo names and missing files', async () => {
    expect(await store.loadDemo('clip.json')).toBeNull();
    expect(await store.loadDemo('clip.demo.exe')).toBeNull();
    expect(await store.loadDemo('ghost.demo')).toBeNull();
  });
});
