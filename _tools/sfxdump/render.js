// Render every sfx to a WAV via the game's own engine + OfflineAudioContext.
// Headless — never touches the visible browser.
//   node render.js            -> writes out/<name>.wav + stats report
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:5199';
const OUT = path.join(__dirname, 'out');
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

function pcmStats(buf) {
  const len = (buf.length - 44) / 2;
  let peak = 0, sumSq = 0, zc = 0, firstNz = -1, lastNz = 0;
  for (let i = 0; i < len; i++) {
    const s = buf.readInt16LE(44 + i * 2) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
    if (i > 0 && Math.sign(s) !== Math.sign(buf.readInt16LE(44 + (i - 1) * 2) / 32768)) zc++;
    if (a > 0.005) { if (firstNz < 0) firstNz = i; lastNz = i; }
  }
  const dur = len / 22050;
  return {
    dur: dur.toFixed(2) + 's',
    peak: peak.toFixed(2),
    rms: Math.sqrt(sumSq / len).toFixed(3),
    active: ((lastNz - firstNz) / 22050).toFixed(2) + 's',
    approxHz: Math.round(zc / 2 / dur),
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[err]', e.message));
  await page.goto(`${BASE}/sfxdump.html`, { waitUntil: 'domcontentloaded' });
  const wavs = await page.evaluate('window.dump');
  await browser.close();

  const rows = [];
  for (const [name, b64] of Object.entries(wavs)) {
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(OUT, `${name}.wav`), buf);
    const st = pcmStats(buf);
    rows.push(`${name.padEnd(24)} peak=${st.peak} rms=${st.rms} active=${st.active} ~${st.approxHz}Hz`);
  }
  fs.writeFileSync(path.join(OUT, 'report.txt'), rows.join('\n'));
  console.log(rows.join('\n'));
})();
