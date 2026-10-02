// w1 multi-angle + w0 hand comparison shots
const { chromium } = require('playwright-core');
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const SHOTS = [['w=1&close=1&yaw=1', 'w1_front.png'], ['w=1&close=1&yaw=0.5', 'w1_side.png'], ['w=1&close=1', 'w1_new.png'], ['w=1', 'w1_hand.png'], ['w=0', 'w0_hand.png']];
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [q, f] of SHOTS) {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto('http://localhost:5199/vmdump.html?ao=on&' + q, { waitUntil: 'domcontentloaded' });
    try { await page.waitForFunction('window.__ready === true', { timeout: 20000 }); } catch { console.log('TIMEOUT', q); }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: __dirname + '/' + f });
    await page.close();
  }
  await browser.close();
  console.log('done');
})();
