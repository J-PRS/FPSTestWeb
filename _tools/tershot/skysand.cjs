// Sweep skytest.html yaw angles for a given face map/flip and screenshot.
const { chromium } = require(require('path').join(__dirname, '..', 'pxcmp', 'node_modules', 'playwright-core'));
const fs = require('fs');
const path = require('path');
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const OUT = path.join(__dirname, 'shots');
const QS = process.env.QS || '';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const tag = (process.env.TAG || 'cube');
  const pitch = process.env.PITCH || '0';
  for (const yaw of [0, 90, 180, 270]) {
    await page.goto(`http://localhost:5199/skytest.html?yaw=${yaw}&pitch=${pitch}${QS}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const f = path.join(OUT, `${tag}_${yaw}.png`);
    await page.screenshot({ path: f });
    console.log('shot', f);
  }
  await browser.close();
})();
