// What ARE the unnamed Groups? Dump each big Group's child types+names.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 12000));
  console.log(await client.page.evaluate(`(() => {
    const scene = (window.__test || {}).scene;
    const info = (window.__renderer && window.__renderer.info) || {};
    const rows = [];
    for (const child of scene.children) {
      let n = 0; const kids = {};
      child.traverse((o) => {
        if (!o.visible) { return; }
        if (o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.isLine || o.isPoints || o.isSprite) {
          n++;
          const t = o.type + (o.name ? ':' + o.name.slice(0, 24) : '');
          kids[t] = (kids[t] || 0) + 1;
        }
      });
      if (n >= 3) { rows.push({ g: (child.name || child.type).slice(0, 24), n, kids: Object.entries(kids).sort((a, b) => b[1] - a[1]).slice(0, 8) }); }
    }
    rows.sort((a, b) => b.n - a.n);
    return JSON.stringify({ draws: info.render ? info.render.calls : '?', rows: rows.slice(0, 25) }, null, 1);
  })()`));
} finally { await closeClient(client); }
