// w1 close 3/4 + in-hand viewmodel shots → w1_new.png / w1_hand.png
const { chromium } = require('playwright-core');
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [q, f] of [['w=1&ao=on&close=1', 'w1_new.png'], ['w=1&ao=on', 'w1_hand.png']]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto('http://localhost:5199/vmdump.html?' + q, { waitUntil: 'domcontentloaded' });
    try { await page.waitForFunction('window.__ready === true', { timeout: 20000 }); } catch { console.log('TIMEOUT'); }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: __dirname + '/' + f });
    await page.close();
  }
  await browser.close();
  console.log('done');
})();
