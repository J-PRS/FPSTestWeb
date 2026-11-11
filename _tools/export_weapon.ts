// Export one viewmodel weapon group to GLB for Blender inspection.
// vmdump.html?export serializes every weapon into window.__glb (wt -> b64 GLB);
// we pull just the requested WeaponType.
//   bun _tools/export_weapon.ts <weaponType> [out.glb] [baseUrl]
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');

const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const wt = process.argv[2] ?? '46';
const out = resolve(process.argv[3] ?? `_scratch/weapon_${wt}.glb`);
const base = process.argv[4] ?? 'http://localhost:5400';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--use-angle=default', '--enable-gpu', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e: Error) => console.log('PAGEERROR', e.message));
await page.goto(`${base}/vmdump.html?export=1&w=${wt}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__ready === true', { timeout: 120_000 });
const glbs = await page.evaluate('window.__glb') as Record<string, string>;
const b64 = glbs[wt];
if (!b64) {
  console.error(`no GLB for weapon type ${wt} — got keys: ${Object.keys(glbs).join(',')}`);
  await browser.close();
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(b64, 'base64'));
console.log(`${out} written (${(Buffer.from(b64, 'base64').length / 1e3).toFixed(1)}KB)`);
await browser.close();
