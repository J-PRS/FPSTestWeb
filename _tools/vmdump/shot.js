// A/B vertex-AO screenshots: /vmdump.html?w=<weapon>&ao=off|on → PNG per combo.
const { chromium } = require('playwright-core');
const fs = require('fs');

const BASE = 'http://localhost:5199/vmdump.html';
const OUT = __dirname;
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const WEAPONS = [0, 1, 3, 4, 5, 6, 7, 9, 11, 12, 13, 14]; // all WeaponType viewmodels

async function shot(browser, w, ao) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await page.goto(`${BASE}?w=${w}&ao=${ao}&close=1`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction('window.__ready === true', { timeout: 15000 });
  } catch { logs.push('TIMEOUT waiting for __ready'); }
  const file = `${OUT}/w${w}_${ao}.png`;
  await page.screenshot({ path: file });
  await page.close();
  if (logs.length) console.log(`w${w} ${ao}:`, logs.join(' | '));
  else console.log(`w${w} ${ao}: ok`);
  return file;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  for (const w of WEAPONS) {
    await shot(browser, w, 'off');
    await shot(browser, w, 'on');
  }
  await browser.close();
})();
