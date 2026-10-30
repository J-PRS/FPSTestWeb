import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9333');
const c = b.contexts()[0];
if (!c) { process.exit(1); }
const p = c.pages().find(x => x.url().includes('5400'));
if (!p) { console.log('no page'); process.exit(1); }
console.log(await p.evaluate(`(async () => {
  const fr = []; let last = performance.now();
  await new Promise(res => { let n = 0; const tick = () => { const now = performance.now(); fr.push(now - last); last = now; if (++n >= 200) return res(); requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(res, 12000); });
  fr.sort((a, b) => a - b);
  const cv = document.getElementById('gl');
  return JSON.stringify({
    frames: fr.length, fps: fr.length ? Math.round(fr.length / (fr.reduce((a, b) => a + b, 0) / 1000)) : 0,
    p50: fr[fr.length >> 1] | 0, p95: fr[(fr.length * 0.95) | 0] | 0, worst: fr[fr.length - 1] | 0,
    cv: cv ? cv.width + 'x' + cv.height : 'none',
  });
})()`));
await b.close();
