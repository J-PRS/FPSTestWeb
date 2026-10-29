// Boot-phase triage v2 — is the loop running, is there a gesture gate,
// what's __test saying. Minimal evals, no fancy serialization.
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://localhost:9333');
const ctx = browser.contexts()[0];
if (!ctx) { process.exit(1); }
const page = ctx.pages().find(p => p.url().includes('localhost:5400'));
if (!page) { console.log('no game page'); process.exit(1); }

const s = await page.evaluate(`(() => {
  const w = window, t = w.__test || {};
  const keys = Object.keys(t);
  const scal = {};
  for (const k of keys) { const v = t[k]; if (v == null || ['number','string','boolean'].includes(typeof v)) scal[k] = v; }
  const lock = document.pointerLockElement;
  const cv = document.querySelector('canvas');
  return JSON.stringify({
    scal, lock: lock ? lock.tagName : null,
    canvases: [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height),
    overlays: [...document.querySelectorAll('body > div')].map(d => (d.id || d.className || '').toString().slice(0,60) + (d.offsetParent ? '' : '·hidden')).slice(0, 30),
    rafs: w.__ph ? w.__ph.frames.length : 'no-ph',
    time: performance.now() | 0,
  });
})()`);
console.log(s);
// Watch rAF for 3s — is the loop alive?
const alive = await page.evaluate(`(async () => { const w = window; w.__ph = { frames: [] }; await new Promise(r => { let n = 0; const tick = () => { w.__ph.frames.push(1); if (++n > 30) return r(); requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(r, 3000); }); return w.__ph.frames.length; })()`);
console.log('raf ticks in ≤3s:', alive);
await browser.close();
