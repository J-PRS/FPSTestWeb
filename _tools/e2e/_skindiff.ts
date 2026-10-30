// Why don't the 3 atlas'd skinned parts merge — dump their bucket keys.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 12000));
  console.log(await client.page.evaluate(`(() => {
    const scene = (window.__test || {}).scene;
    const out = [];
    scene.traverse((o) => {
      if (!o.isSkinnedMesh || out.length > 6) { return; }
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      out.push({
        mesh: o.name.slice(0, 24), mat: m ? m.name : '?',
        skel: o.skeleton ? o.skeleton.bones.length + 'b' : 'none',
        bind: o.bindMatrix.elements.slice(12, 15).map(v => +v.toFixed(2)).join(','),
        pos: o.position.toArray().map(v => +v.toFixed(2)).join(','),
        scl: o.scale.toArray().map(v => +v.toFixed(2)).join(','),
        parent: o.parent ? o.parent.type + ':' + o.parent.name.slice(0, 16) : 'none',
        atlas: m && m.userData && m.userData.atlasMat ? 'Y' : 'n',
      });
    });
    return JSON.stringify(out, null, 1);
  })()`));
} finally { await closeClient(client); }
