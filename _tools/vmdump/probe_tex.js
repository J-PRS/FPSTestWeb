const { chromium } = require('playwright-core');
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('console', m => console.log(m.text()));
  await page.goto('http://localhost:5199/vmdump.html?w=9&close=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  // draw the baked texture fullscreen via a debug hook
  await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    c.style.cssText = 'position:fixed;top:0;left:0;z-index:99';
    document.body.appendChild(c);
    const img = new Image();
    img.onload = () => { c.getContext('2d').drawImage(img, 0, 0, 512, 512); };
    img.src = '/weapons/w9_ao.png';
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'w9_texcheck.png' });
  await browser.close();
})();
