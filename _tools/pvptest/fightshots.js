// Spectate a live bot game and dump frames as webp for the gallery.
// Usage: node fightshots.js [seconds] [room] [bots]
const { chromium } = require(require('path').join(__dirname, '..', 'vmdump', 'node_modules', 'playwright-core'));
const fs = require('fs');
const path = require('path');

const SECS = Number(process.argv[2] || 45);
const ROOM = process.argv[3] || 'fightshots';
const BOTS = Number(process.argv[4] || 8);
const EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = process.env.FIGHT_PORT || '8000';
const BASE = `http://localhost:${process.env.VITE_PORT || '5400'}/?server=localhost:${PORT}&room=${ROOM}&bots=${BOTS}`;
const OUT = path.join(__dirname, '..', '..', 'screenshots', 'fight');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE, headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.addInitScript(`
    window.__lockedEl = null;
    Object.defineProperty(Document.prototype, 'pointerLockElement', {
      get() { return window.__lockedEl; }, configurable: true });
    Element.prototype.requestPointerLock = function () {
      window.__lockedEl = this;
      queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')));
      return Promise.resolve(); };
    document.exitPointerLock = function () {
      window.__lockedEl = null;
      queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange'))); };
  `);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000); // join + spawn + menu dismiss
  // Spectator fly so the camera isn't buried in a bot's head
  await page.keyboard.press('v');
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < SECS * 1000) {
    i++;
    await page.screenshot({ path: path.join(OUT, `fight_${String(i).padStart(3, '0')}.webp`), type: 'webp', quality: 62 });
    await page.waitForTimeout(5000);
  }
  await browser.close();
  console.log('done', i, 'shots ->', OUT);
})();
