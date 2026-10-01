// Identify the top-level unnamed Meshes by correlating with __test lists.
const { chromium } = require(require('path').join(__dirname, '..', 'pxcmp', 'node_modules', 'playwright-core'));
const EXE = 'C:/Users/JPrice/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const ROOM = 'audit-' + Date.now();

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.goto(`http://localhost:5199/?room=${ROOM}&mode=ctf&server=localhost:8001&net=ws`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(50000);
  const report = await page.evaluate(() => {
    const t = window.__test;
    const w = t?.world || {};
    const lists = {};
    for (const k of Object.keys(w)) {
      const v = w[k];
      if (Array.isArray(v)) lists[k] = v.length;
      else if (v instanceof Set || v instanceof Map) lists[k] = v.size;
    }
    // sample the unnamed top-level meshes: bucket by geometry vertex count
    const buckets = {};
    const seen = new Set();
    t.scene.children.forEach((o) => {
      if (o.type !== 'Mesh' || !o.visible) return;
      const g = o.geometry;
      const key = `${g?.type}|v${g?.attributes?.position?.count ?? 0}|i${g?.index?.count ?? 0}`;
      buckets[key] = (buckets[key] || 0) + 1;
      seen.add(g?.uuid);
    });
    const geo = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 25);
    // shared geometry instances — same uuid reused = pooled family
    const shared = {};
    t.scene.children.forEach((o) => {
      if (o.type !== 'Mesh' || !o.visible) return;
      const u = o.geometry?.uuid;
      shared[u] = (shared[u] || 0) + 1;
    });
    const dupes = Object.entries(shared).filter(([, n]) => n > 3).sort((a, b) => b[1] - a[1]).slice(0, 15);
    return { lists, geo, dupes, meshTotal: t.scene.children.filter(o => o.type === 'Mesh' && o.visible).length };
  });
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
})();
