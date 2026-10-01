// Headless terrain probe: join a room, wait for the terrain+mats swap
// to settle, screenshot at intervals so we can SEE what the mats layer
// does to the albedo instead of guessing.
// Requires vite dev on :5199 and the bun server on :8000.
const { chromium } = require(require('path').join(__dirname, '..', 'pxcmp', 'node_modules', 'playwright-core'));
const fs = require('fs');
const path = require('path');

const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const OUT = path.join(__dirname, 'shots');
const ROOM = process.env.ROOM || 'escalade-99';
const WAIT_S = Number(process.env.WAIT_S || 12);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (/mats|albedo|Terrain|terrain/i.test(m.text())) console.log('CON', m.text()); });

  const url = `http://localhost:5199/?room=${ROOM}&mode=nuggets`;
  console.log('goto', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  for (let t = 4; t <= WAIT_S; t += 4) {
    await page.waitForTimeout(4000);
    const f = path.join(OUT, `t${String(t).padStart(2, '0')}.png`);
    await page.screenshot({ path: f });
    console.log('shot', f);
  }
  // dump a couple of shader-relevant uniforms for sanity
  const probe = await page.evaluate(() => {
    const w = window;
    return { keys: Object.keys(w).filter(k => /terrain|mats|debug/i.test(k)) };
  });
  console.log('probe', JSON.stringify(probe));
  await browser.close();
})();
