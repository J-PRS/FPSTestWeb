// Temp probe: BoltLauncher gunlab screenshots — FPS pose + inspect view.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = process.argv[2] ?? 'http://localhost:5399';
const out = 'C:/TEMP/_WEB/FPSWebTest';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message ?? e));
// clear parked gunlab state so we start on wt 0, FPS pose
await page.evaluateOnNewDocument(() => { try { localStorage.removeItem('gunlab'); } catch {} });
await page.goto(`${base}/gunlab.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction('document.querySelectorAll("#rail button").length > 0', { timeout: 60000 });
await page.evaluate(() => {
  [...document.querySelectorAll('#rail button')].find(b => b.textContent?.trim().startsWith('0 '))?.click();
});
await new Promise(r => setTimeout(r, 1500));
await page.screenshot({ path: `${out}/.devin_bow1.png` });
console.log('wrote .devin_bow1.png (FPS view)');
// inspect view
await page.evaluate(() => {
  [...document.querySelectorAll('#rail button')].find(b => b.textContent?.includes('inspect view'))?.click();
});
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: `${out}/.devin_bow2.png` });
console.log('wrote .devin_bow2.png (inspect view)');
// side-ish extra angle: orbit the camera for a second angle? skip.
await browser.close();
