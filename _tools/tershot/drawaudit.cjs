// Join escalade, wait for load, traverse scene, report draw-call suspects.
const { chromium } = require(require('path').join(__dirname, '..', 'pxcmp', 'node_modules', 'playwright-core'));
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const ROOM = 'audit-' + Date.now();

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`http://localhost:5199/?room=${ROOM}&mode=ctf&server=localhost:8001&net=ws`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(50000);
  const report = await page.evaluate(() => {
    const t = window.__test;
    if (!t?.scene) return { err: 'no __test.scene' };
    const byType = {}, byName = {}, byMat = {};
    let meshes = 0, visible = 0, verts = 0;
    const parents = {};
    t.scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isMesh || o.isPoints || o.isSprite || o.isLine || o.isLineSegments) {
        meshes++; if (o.visible) visible++;
        byType[o.type] = (byType[o.type] || 0) + 1;
        const key = o.name || o.type;
        byName[key] = (byName[key] || 0) + 1;
        const gm = o.geometry;
        if (gm?.attributes?.position) verts += gm.attributes.position.count;
        // top-level group identity for aggregation
        let p = o; while (p.parent && p.parent.type !== 'Scene') p = p.parent;
        const gk = `${p.name || p.type}`;
        if (!parents[gk]) parents[gk] = { drawables: 0, verts: 0 };
        parents[gk].drawables++;
        if (gm?.attributes?.position) parents[gk].verts += gm.attributes.position.count;
      }
    });
    const top = Object.entries(parents).sort((a, b) => b[1].drawables - a[1].drawables).slice(0, 20);
    const names = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 30);
    const info = t.rendererSetup?.renderer?.info?.render || t.renderer?.info?.render;
    return { meshes, visible, verts, byType, top, names, info };
  });
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
})();
