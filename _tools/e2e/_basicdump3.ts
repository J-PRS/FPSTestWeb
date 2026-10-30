// Identify every bare-Mesh MeshBasicMaterial draw — name, verts, parent,
// world pos, userData — so the last big bucket gets a real identity.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=ctf&map=bastion&bots=16');
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
      if (o.parent && o.parent.isGroup && o.parent !== scene) { return; } // skip grouped
      const chain = [];
      let a = o.parent;
      while (a && chain.length < 4) { chain.push(a.type + (a.name ? ':' + a.name : '')); a = a.parent; }
      const v = o.geometry?.attributes?.position?.count ?? 0;
      hits.push({
        name: o.name || '-', verts: v,
        ud: Object.keys(o.userData ?? {}).join(',') || '-',
        map: m.map ? 'y' : 'n', col: m.color ? m.color.getHexString() : '-',
        blend: m.blending, parent: chain.join('<') || '-',
      });
    });
    // group identical rows
    const agg = {};
    for (const h of hits) { const k = JSON.stringify([h.name, h.verts, h.map, h.col, h.blend, h.parent, h.ud]); (agg[k] = agg[k] ?? { n: 0, h }).n++; }
    const rows = Object.values(agg).sort((a, b) => b.n - a.n);
    return JSON.stringify({ total: hits.length, rows }, null, 1);
  })()`);
  console.log(out);
} finally { await closeClient(client); }
