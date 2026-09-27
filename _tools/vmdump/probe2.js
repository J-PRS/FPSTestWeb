const { chromium } = require('playwright-core');
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto('http://localhost:5199/vmdump.html?w=0&close=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const s = window.__scene;
    return 'n/a';
  });
  const resp = await page.goto('http://localhost:5199/weapons/w0_baked.glb').catch(e => e.message);
  console.log('glb status', resp && resp.status ? resp.status() : resp);
  await browser.close();
})();
