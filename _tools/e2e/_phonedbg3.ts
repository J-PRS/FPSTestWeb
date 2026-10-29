// DPR + canvas ownership — who owns the 8744px canvas, and what's the
// phone's real devicePixelRatio + max texture size.
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:9333');
const c = b.contexts()[0];
if (!c) { process.exit(1); }
const p = c.pages().find(x => x.url().includes('5400'));
if (!p) { console.log('no page'); process.exit(1); }
console.log(await p.evaluate(`(() => {
  const out = { dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight, maxTex: 0 };
  const gl = document.createElement('canvas').getContext('webgl2');
  if (gl) out.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  out.cvs = [...document.querySelectorAll('canvas')].map(c => ({ w: c.width, h: c.height, id: (c.id || c.className.toString()).slice(0, 50), vis: !!c.offsetParent }));
  const w = window; const r = w.__renderer || (w.__test && w.__test.renderer);
  if (r) { out.renderer = { cw: r.domElement ? r.domElement.width : 0, ch: r.domElement ? r.domElement.height : 0, pr: r.getPixelRatio ? r.getPixelRatio() : 0 }; }
  return JSON.stringify(out);
})()`));
await b.close();
