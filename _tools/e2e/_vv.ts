import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9333');
const c = b.contexts()[0];
if (!c) { process.exit(1); }
const p = c.pages().find(x => x.url().includes('5400'));
if (!p) { console.log('no page'); process.exit(1); }
console.log(await p.evaluate(`JSON.stringify({
  scale: visualViewport.scale, vw: visualViewport.width, vh: visualViewport.height,
  iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio,
  sw: screen.width, sh: screen.height,
  docW: document.documentElement ? document.documentElement.scrollWidth : 0,
  bodyW: document.body ? document.body.scrollWidth : 0,
})`));
await b.close();
