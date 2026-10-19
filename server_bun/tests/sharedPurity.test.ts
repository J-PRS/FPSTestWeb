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
  // Unseeded dice — a sim rolling Math.random desyncs authority vs
  // predictor AND breaks scenario reproducibility. botRand.ts is the
  // one seam (host injects the stream); everything else must take a
  // required rand argument.
  [/\bMath\.random\s*\(/, 'Math.random()'],
  // Implementation-defined natives: JSC (server) and V8 (client) return
  // different ULPs — measured atan2 22% of inputs, hypot 41%, sin/cos
  // ~1.5%. Replayed sims must call shared/dmath.ts instead. Server-side
  // files that never compare bits across engines are allowlisted below.
  [/\bMath\.(sin|cos|tan|asin|acos|atan2?|exp|log|pow|cbrt|hypot)\s*\(/, 'engine-defined Math.* (use dmath)'],
  [/from\s+['"](node:)?(fs|path|os|net|http)['"]/, 'node:* import'],
  [/\brequire\s*\(/, 'require()'],
];

// Files whose math never replays cross-engine (bot brains run wholly
// inside one host; mode adjudication answers over the wire, not via
// replay). They may keep native Math — the engine-defined scan skips
// them; every other ban still applies.
const NATIVE_MATH_OK = /^bot/;

test('shared/ has no host-env reads — all seams go through shared/env.ts', () => {
  const offenders: string[] = [];
  const SEAM = new Set(['env.ts', 'botRand.ts']);
  for (const f of readdirSync(SHARED).filter((f) => f.endsWith('.ts') && !SEAM.has(f))) {
    const src = readFileSync(join(SHARED, f), 'utf-8');
    for (const [re, label] of BANNED) {
      if (label.startsWith('engine-defined') && NATIVE_MATH_OK.test(f)) {continue;}
      for (const m of src.matchAll(new RegExp(re.source, 'g'))) {
        const line = src.slice(0, m.index).split('\n').length;
        const text = (src.split('\n')[line - 1] ?? '').trim();
        if (text.startsWith('//') || text.startsWith('*')) {continue;} // comments
        offenders.push(`${f}:${line} ${label} — ${text.slice(0, 90)}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
