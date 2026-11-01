// bake_atlas.ts — ship the runtime merged+AO'd player atlas as GLBs.
// Loads /modeldump.html headless (the live mergeAtlasParts + bakeVertexAO
// path runs per class variant), pulls window.__glb, writes
// client/public/assets/models/<variant>_atlas.glb. Runtime prefers the
// file in _atlasGeoCache — the 4-5s raycast bake never runs at boot.
//   E2E_GPU=1 bun _tools/bake_atlas.ts [baseUrl]
import { createRequire } from 'node:module';
import { existsSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');

const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = process.argv[2] ?? 'http://localhost:5400';
const OUT = join(import.meta.dir, '..', 'client', 'public', 'assets', 'models');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--use-angle=default', '--enable-gpu', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e: Error) => console.log('PAGEERROR', e.message));
page.on('console', (m: { text(): string }) => { const t = m.text(); if (!t.includes('vite') && !t.includes('Download the React')) {console.log('page:', t);} });
await page.goto(`${base}/modeldump.html?atlasdump=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true', { timeout: 120_000 });
const glbs = await page.evaluate('window.__glb') as Record<string, string>;
const aos = await page.evaluate('window.__ao') as Record<string, string>;
mkdirSync(OUT, { recursive: true });
for (const [name, dataUrl] of Object.entries(aos)) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  writeFileSync(join(OUT, `${name}.webp`), Buffer.from(b64, 'base64'));
  console.log(`${name}.webp written`);
}
// The page exports all variants in ONE GLB - shared accessor pool,
// one fetch, one compression stream across similar vertex data.
const buf = Buffer.from(glbs.players, 'base64');
writeFileSync(join(OUT, 'players_atlas.glb'), buf);
console.log(`players_atlas.glb ${(buf.length / 1e3).toFixed(0)}KB`);
for (const f of readdirSync(OUT).filter((n) => n.endsWith('_atlas.glb') && n !== 'players_atlas.glb')) {
  rmSync(join(OUT, f)); // superseded by the merged bake
}
await browser.close();
if (!existsSync(join(OUT, 'players_atlas.glb'))) {
  console.error('bake failed — players_atlas.glb not emitted');
  process.exit(1);
}
