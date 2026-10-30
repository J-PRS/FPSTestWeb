// What are the unnamed MeshBasicMaterial objects? Dump parent chain,
// geometry size, world position for each.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  const out = await client.page.evaluate(`(() => {
    const scene = window.__scene;
    const hits = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) { return; }
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || !m.isMeshBasicMaterial) { return; }
      const chain = [];
      let a = o;
      while (a && chain.length < 5) { chain.push(a.type + (a.name ? ':' + a.name : '')); a = a.parent; }
      const p = o.geometry?.attributes?.position?.count ?? 0;
      const pos = o.getWorldPosition(new o.position.constructor());
      hits.push({ chain: chain.join('<'), verts: p, pos: [pos.x|0, pos.y|0, pos.z|0].join(','), map: !!m.map, alpha: m.transparent ? +(m.opacity ?? 1).toFixed(2) : 1, depthTest: m.depthTest, renderOrder: o.renderOrder });
    });
    return JSON.stringify(hits.slice(0, 60), null, 1);
  })()`);
  console.log(out);
} finally { await closeClient(client); }
