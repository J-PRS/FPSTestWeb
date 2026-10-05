import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// §5 structural invariant: shared/ is the determinism boundary — a
// Math.random/Date.now/performance.now call in a sim path is an
// untraceable desync (§1 ambient nondeterminism). The ONLY legal ambient
// draw lives in botRand.ts, which is the strictRng gate itself; this
// test fails the moment any other shared file acquires one, instead of
// waiting for a desync to surface it.
const SHARED = join(import.meta.dir, '..', '..', 'shared');
const AMBIENT = /\b(Math\.random|Date\.now|performance\.now)\s*\(/;
// botRand.ts IS the gate — its AMBIENT fallback and the Math.random
// identity check are the mechanism, not violations.
const GATE_FILE = 'botRand.ts';

function codeLines(src: string): { line: number; text: string }[] {
  // Strip block comments and line comments well enough for a draw site:
  // `/*`-`*/` regions and `//`/` * ` line starts carry no calls.
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock.split('\n').map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => !/^\s*(\/\/|\*)/.test(text))
    .map(({ line, text }) => ({ line, text: text.replace(/\/\/.*/, '') }));
}

describe('shared/ ambient-draw boundary', () => {
  const files = readdirSync(SHARED).filter(f => f.endsWith('.ts'));

  it('has sim files to guard', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no ambient draws outside the botRand gate', () => {
    const violations: string[] = [];
    for (const f of files) {
      if (f === GATE_FILE) {continue;}
      for (const { line, text } of codeLines(readFileSync(join(SHARED, f), 'utf8'))) {
        if (AMBIENT.test(text)) {violations.push(`${f}:${line} ${text.trim()}`);}
      }
    }
    expect(violations).toEqual([]);
  });

  it('the strictRng gate itself stays armed', () => {
    const src = readFileSync(join(SHARED, GATE_FILE), 'utf8');
    expect(src).toContain('strictRng');
    expect(src).toContain('botRand drew ambient Math.random');
  });
});
