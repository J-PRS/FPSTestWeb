const { chromium } = require(require('path').join(__dirname, '..', 'pxcmp', 'node_modules', 'playwright-core'));
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const OUT = require('path').join(__dirname, 'shots');
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  const qs = process.env.QS || '';
  const tag = process.env.TAG || 'pose';
  await page.goto(`http://localhost:5199/posedump.html?${qs}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready, null, { timeout: 60000 }).catch(() => console.log('no __ready'));
  await page.waitForTimeout(1500);
  const f = `${OUT}/${tag}.png`;
  await page.screenshot({ path: f });
  console.log('shot', f);
  await browser.close();
})();
