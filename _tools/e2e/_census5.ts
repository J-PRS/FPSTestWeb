// Identify the Groups via userData/constructor, once and for all.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 12000));
  console.log(await client.page.evaluate(`(() => {
    const scene = (window.__test || {}).scene;
    const rows = [];
    for (const child of scene.children) {
      if (child.type !== 'Group') { continue; }
      let n = 0;
      child.traverse((o) => { if (o.visible && (o.isMesh || o.isSprite || o.isSkinnedMesh)) { n++; } });
      if (n < 3) { continue; }
      const ud = Object.keys(child.userData || {});
      const p = child.parent === scene ? 'scene' : (child.parent.type || '?');
      rows.push({ n, ud: ud.join(','), kids: child.children.length, firstChild: child.children[0] ? child.children[0].type + ':' + (child.children[0].name || '') : '' });
    }
    return JSON.stringify(rows.slice(0, 25), null, 1);
  })()`));
} finally { await closeClient(client); }
