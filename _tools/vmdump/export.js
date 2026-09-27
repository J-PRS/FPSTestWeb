// Pulls GLB exports from /vmdump.html?export=1 → _tools/vmdump/models/w*.glb
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const OUT = path.join(__dirname, 'models');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('pageerror', e => { if (e.message !== '0' && e.message !== '__export_done') console.log('PAGEERROR', e.message); });
  page.on('console', m => { const t = m.text(); if (!t.includes('vite')) console.log('page:', t); });
  await page.goto('http://localhost:5199/vmdump.html?export=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__ready === true', { timeout: 30000 });
  const glbs = await page.evaluate('window.__glb');
  for (const [wt, b64] of Object.entries(glbs)) {
    const file = path.join(OUT, `w${wt}.glb`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`w${wt}.glb ${Math.round(fs.statSync(file).size / 1024)}KB`);
  }
  await browser.close();
})();
