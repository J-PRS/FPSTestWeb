import { describe, it, expect } from 'bun:test';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Typography watch: em dashes (U+2014) and en dashes (U+2013) are banned
 *  from source — they mojibake through half the toolchain (you've seen
 *  "ÔÇö" in this very repo's build output). Mass cleanup is queued behind
 *  the current payload; until then, dashBaseline.txt pins today's count
 *  per file: a file may only shrink. New offenders fail outright, and a
 *  pinned file that grows its count fails too. Regenerate the baseline
 *  ONLY after the cleanup: recount and rewrite it. */
const DASH = /[—–]/g;

const root = join(import.meta.dir, '..', '..');
const baseline = new Map<string, number>();
for (const line of readFileSync(join(import.meta.dir, 'dashBaseline.txt'), 'utf8').split('\n')) {
  const m = line.match(/^(\d+)\t(.+)$/);
  if (m) {baseline.set(m[2]!.replaceAll('\\', '/'), Number(m[1]));}
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {yield* walk(p);}
    else if (e.endsWith('.ts')) {yield p;}
  }
}

const offenders: string[] = [];
const grown: string[] = [];
for (const dir of ['shared', 'server_bun/src', 'client/src']) {
  for (const p of walk(join(root, dir))) {
    const rel = relative(root, p).replaceAll('\\', '/');
    const n = (readFileSync(p, 'utf8').match(DASH) ?? []).length;
    if (n === 0) {continue;}
    const pinned = baseline.get(rel);
    if (pinned === undefined) {offenders.push(`${rel} ${n} dashes`);}
    else if (n > pinned) {grown.push(`${rel} ${n} > pinned ${pinned}`);}
  }
}

describe('typography watch (no em/en dashes in source)', () => {
  it('no new file contains dashes', () => {
    expect(offenders).toEqual([]);
  });
  it('pinned files only shrink', () => {
    expect(grown).toEqual([]);
  });
});
