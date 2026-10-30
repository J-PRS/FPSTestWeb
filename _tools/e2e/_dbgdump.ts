// Read the fxDiag dbg labels off the bare basic meshes.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=ctf&map=bastion&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  const out = await client.page.evaluate(`(() => {
    const scene = window.__scene;
    const hits = {};
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) { return; }
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || !m.isMeshBasicMaterial) { return; }
      if (o.parent && o.parent.isGroup && o.parent !== scene) { return; }
      const d = o.userData?.dbg;
      const label = (d && (d.label ?? d.kind ?? Object.keys(d).join('+'))) || 'no-dbg';
      const v = o.geometry?.attributes?.position?.count ?? 0;
      hits[label] = (hits[label] ?? 0) + 1;
      hits[label + '|v' + v] = (hits[label + '|v' + v] ?? 0) + 1;
    });
    return JSON.stringify(hits, null, 1);
  })()`);
  console.log(out);
} finally { await closeClient(client); }
