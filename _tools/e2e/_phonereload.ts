// Reload the game tab on the phone (post-fix), wait for the match, then
// report the canvas buffer + a quick fps read.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9333');
const c = b.contexts()[0];
if (!c) { process.exit(1); }
const p = c.pages().find(x => x.url().includes('5400'));
if (!p) { console.log('no page'); process.exit(1); }
await p.reload();
console.log('reloading — waiting for the match…');
await p.waitForFunction('window.__test && window.__test.playerId', undefined, { timeout: 120000 });
await new Promise(r => setTimeout(r, 12000)); // a few seconds of real gameplay
const s = await p.evaluate(`(async () => {
  const w = window; const cv = document.getElementById('gl');
  const fr = []; let last = performance.now();
  await new Promise(res => { let n = 0; const tick = () => { const now = performance.now(); fr.push(now - last); last = now; if (++n >= 120) return res(); requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(res, 10000); });
  fr.sort((a, b) => a - b);
  const r = w.__renderer || (w.__test && w.__test.renderer);
  return JSON.stringify({
    cv: cv ? cv.width + 'x' + cv.height : 'none', pr: r && r.getPixelRatio ? r.getPixelRatio() : 0,
    iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio,
    frames: fr.length, p50: fr[fr.length >> 1] | 0, p95: fr[(fr.length * 0.95) | 0] | 0,
    fps: fr.length ? Math.round(fr.length / ((fr.reduce((a, b) => a + b, 0)) / 1000)) : 0,
  });
})()`);
console.log(s);
await b.close();
