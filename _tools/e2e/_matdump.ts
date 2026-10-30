// Identify the ~46 remaining castShadow Lambert meshes — color, verts,
// position cluster, userData keys.
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
      if (!m || !m.isMeshLambertMaterial) { return; }
      const v = o.geometry?.attributes?.position?.count ?? 0;
      if (v > 200) { return; }
      const ud = [];
      let a = o;
      while (a && ud.length === 0) {
        const ks = Object.keys(a.userData ?? {});
        if (ks.length) { ud.push(ks.join(',')); }
        a = a.parent;
      }
      const p = o.getWorldPosition(new o.position.constructor());
      hits.push({
        col: m.color ? m.color.getHexString() : '-',
        emis: m.emissive ? m.emissive.getHexString() : '-',
        verts: v, cast: o.castShadow,
        pos: [p.x|0, p.y|0, p.z|0].join(','),
        ud: ud.join('') || '-',
      });
    });
    const byCol = {};
    for (const h of hits) { const k = h.col + '/' + h.emis; byCol[k] = (byCol[k] ?? 0) + 1; }
    return JSON.stringify({ byCol, sample: hits.slice(0, 40) }, null, 1);
  })()`);
  console.log(out);
} finally { await closeClient(client); }
