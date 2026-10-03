const { chromium } = require('playwright-core');
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [name, yaw] of [['side', 0], ['back', 0.5], ['front', 1.0]]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    page.on('pageerror', e => console.log('PAGEERROR', e.message));
    await page.goto(`http://localhost:5199/vmdump.html?w=1&ao=on&close=1&yaw=${yaw}`, { waitUntil: 'domcontentloaded' });
    try { await page.waitForFunction('window.__ready === true', { timeout: 20000 }); } catch { console.log('TIMEOUT'); }
    await page.screenshot({ path: `${__dirname}/w1_${name}.png` });
    await page.close();
  }
  await browser.close();
  console.log('done');
})();
