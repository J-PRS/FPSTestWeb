// Long-settle headless probe: wait for interiors + terrain + sky to land,
// logging the loader milestones, then screenshot at intervals.
const { chromium } = require(require('path').join(__dirname, '..', 'pxcmp', 'node_modules', 'playwright-core'));
const fs = require('fs');
const path = require('path');

const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const OUT = path.join(__dirname, 'shots');
const ROOM = process.env.ROOM || 'escalade-92';
const QS = process.env.QS || '';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/int |interior|swapp|sky|albedo|fail|error|warn|terrain/i.test(t)) console.log('CON', t.slice(0, 160));
  });
  const SERVER = process.env.SERVER || 'localhost:8001';
  await page.goto(`http://localhost:5199/?room=${ROOM}&mode=nuggets&server=${SERVER}${QS}`, { waitUntil: 'domcontentloaded' });
  for (let t = 10; t <= 50; t += 10) {
    await page.waitForTimeout(10000);
    const f = path.join(OUT, `settle_${t}s.png`);
    await page.screenshot({ path: f });
    console.log('shot', f);
  }
  await browser.close();
})();
