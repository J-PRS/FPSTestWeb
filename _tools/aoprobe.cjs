const puppeteer = require('puppeteer-core');
const { existsSync } = require('fs');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!existsSync(chrome)) { console.log('no chrome'); process.exit(1); }
(async () => {
  const b = await puppeteer.launch({ executablePath: chrome, headless: true,
    args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio','--no-sandbox'] });
  const p = await b.newPage();
  await p.goto('http://localhost:5400/gunlab.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('window.__gunlab && window.__gunlab.scene', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));
  const out = await p.evaluate(() => {
    const res = {};
    window.__gunlab.scene.traverse(o => {
      if (!o.isMesh) return;
      let g = o; while (g.parent && g.parent !== window.__gunlab.scene) g = g.parent;
      const col = o.geometry.getAttribute('color');
      const key = g.name || g.userData?.wt || 'grp';
      const label = key + (g.visible === false ? '|hidden' : '');
      if (!col) { (res[label + '|noColor'] ??= 0); res[label + '|noColor']++; return; }
      let s = 0, lo = 1, hi = 0; for (let i = 0; i < col.count; i++) { const v = col.getX(i); s += v; if (v < lo) lo = v; if (v > hi) hi = v; }
      (res[label] ??= []).push(`${o.name || o.geometry.type}:avg${(s / col.count).toFixed(2)} lo${lo.toFixed(2)} hi${hi.toFixed(2)} n${col.count}`);
    });
    return res;
  });
  console.log(JSON.stringify(out).slice(0, 6000));
  await b.close();
})();
