/**
 * gunsheet.ts — headless gunlab sheet generator.
 *
 * bun _tools/e2e/gunsheet.ts <weaponType> [viteUrl]
 *
 * Opens /gunlab.html in headless Chrome (SwiftShader), picks the weapon
 * rail button, clicks "▦ sheet", and waits for client/shots/w<N>_sheet.png
 * to land via the dev server's /shot middleware.
 */
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');

const wt = Number(process.argv[2]);
if (!Number.isInteger(wt)) { console.error('usage: bun gunsheet.ts <weaponType>'); process.exit(1); }
const base = process.argv[3] ?? 'http://localhost:5173';

const CHROME = process.env.CHROME_PATH
  ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
if (!CHROME) { console.error('chrome not found — set CHROME_PATH'); process.exit(1); }

const outPath = resolve(import.meta.dir, '../../client/shots', `w${wt}_sheet.png`);
const before = existsSync(outPath) ? statSync(outPath).mtimeMs : 0;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('[pageerror]', e instanceof Error ? e.message : e));

await page.goto(`${base}/gunlab.html`, { waitUntil: 'networkidle0', timeout: 30000 });
// The module builds every weapon before paintRail — networkidle alone
// fires too early (edge-bake logs still streaming).
await page.waitForFunction('document.querySelectorAll("#rail button").length > 0', { timeout: 30000 });
// Pick the weapon by its rail button label ("8 Lightning" → match prefix).
const picked = await page.evaluate((w) => {
  const btn = [...document.querySelectorAll<HTMLElement>('#rail button')].find(b => b.textContent?.trim().startsWith(`${w} `));
  btn?.click();
  return btn?.textContent?.trim() ?? null;
}, wt);
if (!picked) { console.error(`no rail button for wt ${wt}`); await browser.close(); process.exit(1); }
console.log('picked:', picked);

// Let the switch settle, then trigger the sheet.
await new Promise(r => setTimeout(r, 800));
const fired = await page.evaluate(() => {
  const btn = [...document.querySelectorAll<HTMLElement>('#rail button')].find(b => b.textContent?.includes('sheet'));
  btn?.click();
  return !!btn;
});
if (!fired) { console.error('sheet button not found'); await browser.close(); process.exit(1); }

// Wait for the middleware to drop the PNG (SwiftShader renders are slow).
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  if (existsSync(outPath) && statSync(outPath).mtimeMs > before) {
    console.log('wrote', outPath);
    await browser.close();
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 250));
}
console.error('timed out waiting for', outPath);
await browser.close();
process.exit(1);
