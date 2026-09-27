// A/B color comparison: same page, ?pixelated=off vs ?pixelated=hard.
// Captures the WebGL canvas region, then compares mean RGB over stable
// areas (sky strip, terrain mid) plus global RMSE of a downsampled grid.
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const fs = require('fs');

const BASE = 'http://localhost:5199';
const OUT = __dirname;
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

async function shot(url, file) {
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000); // let the scene spawn + settle
  await page.screenshot({ path: file });
  await browser.close();
}

function analyze(png) {
  const { width, height, data } = png;
  const regions = {
    sky:    { x0: 0.2, x1: 0.8, y0: 0.08, y1: 0.20 },
    terrain:{ x0: 0.1, x1: 0.5, y0: 0.55, y1: 0.80 },
    full:   { x0: 0.0, x1: 1.0, y0: 0.0,  y1: 1.0  },
  };
  const res = {};
  for (const [name, r] of Object.entries(regions)) {
    let rs = 0, gs = 0, bs = 0, n = 0;
    // sample every 4th pixel to dodge the pixel grid pattern
    for (let y = Math.floor(r.y0 * height); y < r.y1 * height; y += 4)
      for (let x = Math.floor(r.x0 * width); x < r.x1 * width; x += 4) {
        const i = (y * width + x) * 4;
        rs += data[i]; gs += data[i + 1]; bs += data[i + 2]; n++;
      }
    res[name] = { mean: [rs / n, gs / n, bs / n].map(v => Math.round(v * 10) / 10) };
  }
  return res;
}

function rmse(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let sum = 0;
  for (let i = 0; i < n; i += 16) { // skip alpha, sparse-sample
    const d = a.data[i] - b.data[i];
    sum += d * d;
  }
  return Math.round(Math.sqrt(sum / (n / 4)) * 10) / 10;
}

(async () => {
  const fA = OUT + '/off.png', fB = OUT + '/hard.png', fC = OUT + '/postpro.png';
  await shot(`${BASE}/?pixelated=off&bloom=off&postpro=off`, fA);
  await shot(`${BASE}/?pixelated=hard&bloom=off&postpro=off`, fB);
  await shot(`${BASE}/?pixelated=off&bloom=off&postpro=on`, fC);
  const a = PNG.sync.read(fs.readFileSync(fA));
  const b = PNG.sync.read(fs.readFileSync(fB));
  const c = PNG.sync.read(fs.readFileSync(fC));
  const ra = analyze(a), rb = analyze(b), rc = analyze(c);
  console.log('OFF :', JSON.stringify(ra));
  console.log('HARD:', JSON.stringify(rb));
  console.log('PPR :', JSON.stringify(rc));
  for (const k of Object.keys(ra)) {
    const d1 = ra[k].mean.map((v, i) => Math.round((rb[k].mean[i] - v) * 10) / 10);
    const d2 = ra[k].mean.map((v, i) => Math.round((rc[k].mean[i] - v) * 10) / 10);
    console.log(`${k}: hard delta ${JSON.stringify(d1)} | postpro delta ${JSON.stringify(d2)}`);
  }
  console.log('RMSE off-vs-hard:', rmse(a, b), '| off-vs-postpro:', rmse(a, c));
})().catch(e => { console.error(e); process.exit(1); });
