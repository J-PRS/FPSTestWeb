// Dump each remote's skinned material props — are armor/dark/accent
// color-only variants (vertex-color mergeable) or real differences?
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 12000));
  console.log(await client.page.evaluate(`(() => {
    const scene = (window.__test || {}).scene;
    const out = [];
    let seen = 0;
    scene.traverse((o) => {
      if (!o.isSkinnedMesh || seen > 4) { return; }
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m) { return; }
      seen++;
      out.push({
        mesh: o.name.slice(0, 30),
        mat: (m.name || m.type).slice(0, 30),
        type: m.type,
        color: m.color ? m.color.getHexString() : null,
        map: !!m.map, rough: m.roughness, metal: m.metalness,
        emis: m.emissive ? m.emissive.getHexString() : null,
        emisMap: !!m.emissiveMap, norm: !!m.normalMap,
        vertexColors: !!m.vertexColors,
        transparent: m.transparent, flat: m.flatShading,
        skinning: m.skinning === undefined ? 'n/a' : m.skinning,
      });
    });
    return JSON.stringify(out, null, 1);
  })()`));
} finally { await closeClient(client); }
