// Phone GL-state triage — is the canvas alive, is WebGL lost, what's
// __test saying, and the last console errors.
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://localhost:9333');
const ctx = browser.contexts()[0];
if (!ctx) { process.exit(1); }
const page = ctx.pages().find(p => p.url().includes('localhost:5400'));
if (!page) { console.log('no game page'); process.exit(1); }
const errs: string[] = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warn') { errs.push(m.text().slice(0, 400)); } });
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
const s = await page.evaluate(() => {
  const cv = document.querySelector('canvas');
  const w = window as unknown as { __test?: Record<string, unknown>; __renderer?: { info: { render: { calls: number; triangles: number } }; getContext(): { isContextLost(): boolean } } };
  const gl = cv?.getContext('webgl2');
  return {
    url: location.href, vis: document.visibilityState,
    canvas: cv ? `${cv.width}x${cv.height}` : 'none',
    glLost: gl ? gl.isContextLost() : 'no ctx',
    rendererLost: w.__renderer ? w.__renderer.getContext().isContextLost() : 'no __renderer',
    draws: w.__renderer ? w.__renderer.info.render.calls : null,
    tris: w.__renderer ? w.__renderer.info.render.triangles : null,
    testKeys: w.__test ? Object.keys(w.__test).slice(0, 25) : [],
    testState: w.__test ? JSON.stringify(Object.fromEntries(Object.entries(w.__test).filter(([, v]) => typeof v !== 'object' && typeof v !== 'function'))).slice(0, 600) : 'none',
  };
});
await new Promise(r => setTimeout(r, 4000));
console.log(JSON.stringify(s, null, 1));
console.log('console tail:', errs.slice(-15));
await browser.close();
