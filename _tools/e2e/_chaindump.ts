// Name the remaining Mesh<Group<Group / Mesh<Group<Scene objects —
// dump chain + world pos + verts for Lambert meshes inside 2-deep Groups.
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
      const chain = [];
      let a = o;
      while (a && chain.length < 6) { chain.push(a.type + (a.name ? ':' + a.name : '')); a = a.parent; }
      const p = o.getWorldPosition(new o.position.constructor());
      hits.push({ chain: chain.join('<'), verts: o.geometry?.attributes?.position?.count ?? 0, pos: [p.x|0, p.y|0, p.z|0].join(','), cast: o.castShadow });
    });
    return JSON.stringify(hits.slice(0, 80), null, 1);
  })()`);
  console.log(out);
} finally { await closeClient(client); }
