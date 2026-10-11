import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Asset-manifest gate: every asset path the code names literally must exist
// under client/public — a missing GLB should fail the suite, not surface in
// the browser console as a fetch 404 three layers from the cause.
// Dynamic bakes (w${wt}_baked.glb etc.) are intentionally optional by design —
// swapBaked falls back to procedural — so template paths only assert that the
// static directory prefix exists.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.resolve(SRC, '..', 'public');
const EXTS = '(?:glb|gltf|png|jpg|jpeg|avif|webp|ktx2|hdr|bin|wav|mp3|ogg|ttf|woff2?|json)';
const LIT_RE = new RegExp(`['"\`](/(assets|weapons|sfx|fonts)/[^'"\`]+\\.${EXTS})['"\`]`, 'g');
const TPL_RE = new RegExp('`(/(assets|weapons|sfx|fonts)/[^`]*\\$\\{[^`]*)`', 'g');

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {yield* walk(p);}
    else if (e.name.endsWith('.ts')) {yield p;}
  }
}

// Named debt, not silence: literal paths known to be absent land here with
// their reason, never silently. Empty while the manifest is clean.
const KNOWN_MISSING = new Set<string>();

describe('asset manifest', (): void => {
  const missing: string[] = [];
  const missingDirs = new Set<string>();
  for (const file of walk(SRC)) {
    if (file.includes('__tests__')) {continue;}
    const src = fs.readFileSync(file, 'utf-8');
    const rel = path.relative(SRC, file);
    for (const m of src.matchAll(LIT_RE)) {
      const [, p] = m;
      if (p!.includes('${')) {continue;} // template literal — TPL_RE handles it
      if (KNOWN_MISSING.has(p!)) {continue;}
      if (!fs.existsSync(path.join(PUB, p!))) {missing.push(`${rel} -> ${p}`);}
    }
    for (const m of src.matchAll(TPL_RE)) {
      const prefix = m[1].split('${')[0]!;
      const dir = prefix.slice(0, prefix.lastIndexOf('/') + 1);
      if (dir.length > 1 && !fs.existsSync(path.join(PUB, dir))) {missingDirs.add(`${rel} -> ${dir}`);}
    }
  }
  it('every literal asset path exists under client/public', (): void => {
    expect(missing).toEqual([]);
  });
  it('every dynamic-path directory prefix exists', (): void => {
    expect([...missingDirs]).toEqual([]);
  });
});
