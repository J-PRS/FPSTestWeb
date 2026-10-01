// Sky/terrain proof: join escalade, wait for full load, then screenshot
// 4 headings + up + down via the __test hook (player.yaw/pitch).
const { chromium } = require(require('path').join(__dirname, '..', 'pxcmp', 'node_modules', 'playwright-core'));
const fs = require('fs');
const path = require('path');

const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const OUT = path.join(__dirname, 'shots');
const ROOM = process.env.ROOM || 'escalade-1';
const QS = process.env.QS || '';
const SERVER = process.env.SERVER || 'localhost:8001';
const MODE = process.env.MODE || 'ctf';

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
    if (/sky|albedo|mats|terrain|fail|error/i.test(t)) console.log('CON', t.slice(0, 160));
  });
  await page.goto(`http://localhost:5199/?room=${ROOM}&mode=${MODE}&server=${SERVER}${QS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(45000); // swiftshader runs ~7x slow — give assets time
  const views = [
    ['n', 0, 0], ['e', 90, 0], ['s', 180, 0], ['w', 270, 0],
    ['up', 0, -80], ['down', 0, 80], ['horizon', 45, 15],
  ];
  for (const [name, yaw, pitch] of views) {
    await page.evaluate(([y, p]) => {
      const t = window.__test;
      if (t?.player) { t.player.yaw = y * Math.PI / 180; t.player.pitch = p * Math.PI / 180; }
    }, [yaw, pitch]);
    await page.waitForTimeout(1500);
    const f = path.join(OUT, `proof_${name}.png`);
    await page.screenshot({ path: f });
    console.log('shot', f);
  }
  await browser.close();
})();
