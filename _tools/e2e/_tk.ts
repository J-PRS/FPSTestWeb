import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9333');
const c = b.contexts()[0];
if (!c) { process.exit(1); }
const p = c.pages().find(x => x.url().includes('5400'));
if (!p) { console.log('no page'); process.exit(1); }
console.log(await p.evaluate(`(() => {
  const t = window.__test || {};
  const out = {};
  for (const k of Object.keys(t)) { const v = t[k]; out[k] = v == null ? 'null' : (typeof v === 'object' ? (v.id ?? v.name ?? v.constructor?.name ?? 'obj') : v); }
  const cv = document.getElementById('gl');
  out.__cv = cv ? cv.width + 'x' + cv.height : 'none';
  return JSON.stringify(out);
})()`));
await b.close();
