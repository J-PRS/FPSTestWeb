// Scene-children census — per top-level group, count visible renderables
// inside (the first eval couldn't attribute unnamed meshes to clusters).
import { launchClient, closeClient } from './browser.ts';

const client = await launchClient('http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16' + (process.argv[2] ?? ''));
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 12000));
  const census = await client.page.evaluate(`(() => {
    const scene = (window.__test || {}).scene;
    if (!scene) { return 'no scene'; }
    const info = (window.__renderer && window.__renderer.info) || {};
    const out = [];
    for (const child of scene.children) {
      let meshes = 0, skinned = 0, inst = 0, other = 0, mats = new Set();
      child.traverse((o) => {
        if (!o.visible) { return; }
        if (o.isSkinnedMesh) { skinned++; }
        else if (o.isInstancedMesh) { inst++; }
        else if (o.isMesh) { meshes++; }
        else if (o.isLine || o.isPoints || o.isSprite) { other++; }
        if (o.material) { for (const m of [].concat(o.material)) { mats.add(m.type + (m.map ? '+tex' : '')); } }
      });
      if (meshes + skinned + inst + other > 0) {
        out.push({ name: child.name || child.type, mesh: meshes, skin: skinned, inst, other, mats: [...mats].slice(0, 6) });
      }
    }
    out.sort((a, b) => (b.mesh + b.skin + b.inst) - (a.mesh + a.skin + a.inst));
    return JSON.stringify({ draws: info.render ? info.render.calls : '?', tris: info.render ? info.render.triangles : '?', out }, null, 1);
  })()`);
  console.log(census);
} finally { await closeClient(client); }
