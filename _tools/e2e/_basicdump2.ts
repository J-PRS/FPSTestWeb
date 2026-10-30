// World-baked check: bbox center + material color/uuid for the
// MeshBasicMaterial origin-parked meshes.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  const out = await client.page.evaluate(`(() => {
    const scene = window.__scene;
    const byMat = new Map();
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) { return; }
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || !m.isMeshBasicMaterial) { return; }
      if (!o.geometry.boundingSphere) { o.geometry.computeBoundingSphere(); }
      const c = o.geometry.boundingSphere.center;
      const key = m.uuid;
      const row = byMat.get(key) ?? { color: m.color ? '#' + m.color.getHexString() : '?', n: 0, verts: 0, centers: [], side: m.side, blending: m.blending, opacity: m.opacity };
      row.n++; row.verts += o.geometry.attributes.position.count;
      row.centers.push([c.x|0, c.y|0, c.z|0].join(','));
      byMat.set(key, row);
    });
    return JSON.stringify([...byMat.values()], null, 1);
  })()`);
  console.log(out);
} finally { await closeClient(client); }
