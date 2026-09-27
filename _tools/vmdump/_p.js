const { chromium } = require('playwright-core');
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('console', m => { const t = m.text(); if (t.includes('[vm]')) console.log(t); });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto('http://localhost:5199/vmdump.html?w=0&close=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__ready === true', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'w0_baked.png' });
  await browser.close();
})();
