// Scene draw-call census — solo match, traverse the live scene, count
// visible renderables grouped by type + material + top-level cluster.
//   set E2E_GPU=1& bun _tools/e2e/_census.ts
import { launchClient, closeClient } from './browser.ts';

const client = await launchClient(process.argv[2] ?? 'http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, Number(process.argv[3] ?? 8000)));
  const census = await client.page.evaluate(`(() => {
    const scene = (window.__test || {}).scene;
    if (!scene) { return 'no scene'; }
    const info = (window.__test.renderer && window.__test.renderer.info)
      || (window.__renderer && window.__renderer.info);
    const buckets = {};
    const mats = new Map();
    const add = (o) => {
      // cluster = nearest named ancestor under scene
      let cl = o.name || o.type;
      let p = o.parent;
      while (p && p !== scene) { if (p.name) { cl = p.name; } p = p.parent; }
      const key = o.type;
      buckets[key] = buckets[key] || { n: 0, clusters: {} };
      buckets[key].n++;
      buckets[key].clusters[cl] = (buckets[key].clusters[cl] || 0) + 1;
      const m = o.material;
      if (m) {
        const mid = Array.isArray(m) ? 'multi:' + m.length : (m.name || m.type + ':' + m.uuid.slice(0, 8));
        mats.set(mid, (mats.get(mid) || 0) + 1);
      }
    };
    scene.traverse((o) => {
      if (!o.visible) { return; }
      if (o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.isLine || o.isPoints || o.isSprite) { add(o); }
    });
    const top = Object.entries(buckets).sort((a, b) => b[1].n - a[1].n)
      .map(([k, v]) => k + '=' + v.n + ' ' + JSON.stringify(Object.fromEntries(Object.entries(v.clusters).sort((x, y) => y[1] - x[1]).slice(0, 8))));
    const matTop = [...mats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    return JSON.stringify({ draws: info ? info.render.calls : '?', tris: info ? info.render.triangles : '?', top, matTop }, null, 1);
  })()`);
  console.log(census);
} finally { await closeClient(client); }
