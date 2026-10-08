/**
 * structshot.ts — headless gunlab structure screenshots.
 * bun _tools/e2e/structshot.ts <piece> [piece...]
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');

const pieces = process.argv.slice(2);
const base = 'http://localhost:5400';
const CHROME = process.env.CHROME_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 900 });
page.on('pageerror', (e) => console.error('[pageerror]', e instanceof Error ? e.message : e));

await page.goto(`${base}/gunlab.html`, { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction('document.querySelectorAll("#rail button").length > 0', { timeout: 30000 });
// Switch category to structures.
await page.evaluate(() => {
  const sel = [...document.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === 'structures'));
  if (sel) { sel.value = 'structures'; sel.dispatchEvent(new Event('change')); }
});
await new Promise((r) => setTimeout(r, 600));

for (const piece of pieces) {
  const ok = await page.evaluate((p) => {
    const btn = [...document.querySelectorAll<HTMLElement>('#rail button')].find((b) => b.textContent?.trim() === p);
    btn?.click();
    return !!btn;
  }, piece);
  if (!ok) { console.error(`no rail button for ${piece}`); continue; }
  // AO bake on SwiftShader is slow; then force inspect off→on so the
  // camera reframes the finished piece.
  await new Promise((r) => setTimeout(r, 4000));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll<HTMLElement>('#rail button')].find((b) => b.textContent?.includes('inspect'));
    btn?.click(); btn?.click();
  });
  await new Promise((r) => setTimeout(r, 1200));
  const out = resolve(import.meta.dir, `../../screenshots/struct_${piece}.png`);
  await page.screenshot({ path: out });
  console.log('wrote', out);
}
await browser.close();
