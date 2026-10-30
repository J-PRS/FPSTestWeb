// Fingerprint the ~3-mesh Groups: world pos, geometry verts, material color.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 12000));
  console.log(await client.page.evaluate(`(() => {
    const scene = (window.__test || {}).scene;
    const rows = [];
    const v = new (Object.getPrototypeOf(scene.position).constructor)();
    for (const child of scene.children) {
      if (child.type !== 'Group') { continue; }
      const meshes = [];
      child.traverse((o) => { if (o.visible && o.isMesh) { meshes.push(o); } });
      const sprites = [];
      child.traverse((o) => { if (o.visible && o.isSprite) { sprites.push(o); } });
      if (meshes.length < 2) { continue; }
      child.getWorldPosition(v);
      rows.push({
        pos: v.x.toFixed(0) + ',' + v.y.toFixed(0) + ',' + v.z.toFixed(0),
        n: meshes.length + sprites.length,
        parts: meshes.slice(0, 5).map(m => (m.geometry.attributes.position ? m.geometry.attributes.position.count : 0) + 'v/' + (m.material && m.material.color ? m.material.color.getHexString() : '?')),
        spr: sprites.length,
      });
    }
    rows.sort((a, b) => b.n - a.n);
    return JSON.stringify(rows.slice(0, 20), null, 1);
  })()`));
} finally { await closeClient(client); }
