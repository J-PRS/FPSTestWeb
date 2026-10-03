import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// shared/ is compiled into the browser bundle AND the deterministic sims —
// host-environment reads (process.env, Date.now, fs, Bun globals) must not
// live there. The one legal seam is shared/env.ts, seeded by the host.
// This test fails the moment a direct env read sneaks back in.
const SHARED = join(import.meta.dir, '../../shared');
const BANNED: [RegExp, string][] = [
  [/\bprocess\.(env|argv|cwd|exit|version)\b/, 'process.*'],
  [/\bBun\./, 'Bun.*'],
  [/\bDate\.now\s*\(/, 'Date.now()'],
  [/\bnew\s+Date\s*\(/, 'new Date()'],
  [/from\s+['"](node:)?(fs|path|os|net|http)['"]/, 'node:* import'],
  [/\brequire\s*\(/, 'require()'],
];

test('shared/ has no host-env reads — all seams go through shared/env.ts', () => {
  const offenders: string[] = [];
  for (const f of readdirSync(SHARED).filter((f) => f.endsWith('.ts') && f !== 'env.ts')) {
    const src = readFileSync(join(SHARED, f), 'utf-8');
    for (const [re, label] of BANNED) {
      for (const m of src.matchAll(new RegExp(re.source, 'g'))) {
        const line = src.slice(0, m.index).split('\n').length;
        const text = (src.split('\n')[line - 1] ?? '').trim();
        if (text.startsWith('//') || text.startsWith('*')) continue; // comments
        offenders.push(`${f}:${line} ${label} — ${text.slice(0, 90)}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
