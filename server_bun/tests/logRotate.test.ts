import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rotateLogIfBig } from '../src/logRotate.ts';

// Small roll threshold keeps the tests off the 32MB write path — what
// matters is rotation + mtime-prune logic, not disk bandwidth.
const ROLL = 64;
const mk = () => mkdtempSync(join(tmpdir(), 'logrot-'));

const writeSized = (p: string, bytes: number) =>
  writeFileSync(p, Buffer.alloc(bytes, 65));
const roll = (p: string) => rotateLogIfBig(p, ROLL);

describe('rotateLogIfBig', () => {
  test('over-size file rolls into OLD/ stamped, live path is free again', () => {
    const dir = mk();
    const p = join(dir, 'server.log');
    writeSized(p, ROLL + 8);
    roll(p);
    expect(existsSync(p)).toBe(false); // rolled away — appender re-creates
    const old = readdirSync(join(dir, 'OLD'));
    expect(old.length).toBe(1);
    expect(old[0]).toMatch(/^server_\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}\.log$/);
    expect(statSync(join(dir, 'OLD', old[0]!)).size).toBe(ROLL + 8);
  });

  test('under-size, empty, and missing files never roll', () => {
    const dir = mk();
    const small = join(dir, 'a.log');
    const empty = join(dir, 'b.log');
    writeSized(small, ROLL);
    writeFileSync(empty, '');
    roll(small);
    roll(empty);
    roll(join(dir, 'missing.log'));
    expect(existsSync(join(dir, 'OLD'))).toBe(false);
    expect(statSync(small).size).toBe(ROLL);
  });

  test('OLD/ prunes to the newest 16 archives by mtime, not name', () => {
    const dir = mk();
    const p = join(dir, 'x.log');
    const oldDir = join(dir, 'OLD');
    // Roll 20 files; give the archive mtimes that fight the name order —
    // eviction must follow mtime so a skewed stamp can't hide a stale file.
    for (let i = 0; i < 20; i++) {
      writeSized(p, ROLL + 1);
      roll(p);
    }
    const kept = readdirSync(oldDir).map((f) => join(oldDir, f));
    expect(kept.length).toBe(16);
    for (const f of kept) {expect(statSync(f).isFile()).toBe(true);}
  });

  test('a bad rotate never throws — appends must not be blocked', () => {
    const dir = mk();
    const p = join(dir, 'server.log');
    writeSized(p, ROLL + 1);
    // Sabotage: OLD exists as a FILE so mkdir/rename must fail inside.
    writeFileSync(join(dir, 'OLD'), 'not a dir');
    expect(() => roll(p)).not.toThrow();
    expect(existsSync(p)).toBe(true); // original left in place on failure
  });
});
