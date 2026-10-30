// Full named ancestor chain for the small Lambert meshes.
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
      if (v > 60) { return; }
      const chain = [];
      let a = o;
      while (a && chain.length < 8) { chain.push((a.type || '?') + ':' + (a.name || '?')); a = a.parent; }
      hits.push({ chain: chain.join('<'), verts: v });
    });
    return JSON.stringify(hits.slice(0, 60), null, 1);
  })()`);
  console.log(out);
} finally { await closeClient(client); }
