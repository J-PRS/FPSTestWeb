/**
 * zfight.ts — coplanar-triangle audit over every gunlab weapon.
 *
 * bun _tools/e2e/zfight.ts [viteUrl]
 *
 * Opens /gunlab.html headless and calls window.__gl.zcheck(), which
 * buckets each weapon's world-space triangles by plane and SAT-tests
 * coplanar pairs for overlap — the same plane-bucket + 2D-intersection
 * algorithm every "find z-fighting" tool uses.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
const base = process.argv[2] ?? 'http://localhost:5173';

const CHROME = process.env.CHROME_PATH
  ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
if (!CHROME) { console.error('chrome not found — set CHROME_PATH'); process.exit(1); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e instanceof Error ? e.message : e));
await page.goto(`${base}/gunlab.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gl && window.__gl.zcheck', { timeout: 30000 });

const results = await page.evaluate('window.__gl.zcheck()') as { wt: number; pairs: number; at: number[][]; who: string[] }[];
if (!results.length) console.log('clean — no coplanar overlaps in any weapon');
for (const r of results) {
  console.log(`w${r.wt}: ${r.pairs} coplanar overlapping tri-pairs`);
  r.at.forEach((p, i) => console.log(`   near (${p.join(', ')})  ${r.who[i]}`));
}
// Boundary-edge census — open rims are holes (some intentional, e.g.
// bore discs; the report shows midpoint + mesh so intent is checkable).
const holes = await page.evaluate('window.__gl.holecheck()') as { wt: number; holes: number; at: number[][]; who: string[] }[];
if (!holes.length) console.log('sealed — no open edges in any weapon');
for (const r of holes) {
  console.log(`w${r.wt}: ${r.holes} open boundary edges`);
  r.at.forEach((p, i) => console.log(`   near (${p.join(', ')})  ${r.who[i]}`));
}
await browser.close();
process.exit(results.length ? 1 : 0);
