// Shoots every animation clip of each player model on the white posedump
// page into screenshots/poses (robot) and screenshots/poses-man (UAL).
// Requires the vite dev server on :5199.
const { chromium } = require(require('path').join(__dirname, '..', 'vmdump', 'node_modules', 'playwright-core'));
const fs = require('fs');
const path = require('path');

const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const BASE = 'http://localhost:5199/posedump.html';
const OUT_ROOT = path.join(__dirname, '..', '..', 'screenshots');

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  for (const [model, outDir, scale] of [
    ['mannequin', 'poses-medium', '1'],
    ['mannequin', 'poses-light', '0.92'],
    ['mannequin', 'poses-heavy', '1.15'],
  ]) {
    await page.goto(`${BASE}?model=${model}&scale=${scale}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__ready === true', { timeout: 20000 });
    const clips = await page.evaluate(() => window.__clips);
    console.log(model, clips.length, 'clips');
    const dir = path.join(OUT_ROOT, outDir);
    fs.mkdirSync(dir, { recursive: true });
    for (const clip of clips) {
      // one-shot clips read best mid-arc; let the page pick via t=0.4
      await page.goto(`${BASE}?model=${model}&scale=${scale}&clip=${encodeURIComponent(clip)}&t=0.4`,
        { waitUntil: 'domcontentloaded' });
      await page.waitForFunction('window.__ready === true', { timeout: 20000 });
      await page.waitForTimeout(250); // let one real frame hit the canvas
      await page.screenshot({ path: path.join(dir, `${clip}.png`) });
      process.stdout.write(clip + ' ');
    }
    console.log('\ndone', outDir);
  }
  await browser.close();
})();
