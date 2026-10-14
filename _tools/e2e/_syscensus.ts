import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=syscen&map=crossfire&bots=10&mode=ctf'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 5`, 20000);
await new Promise((r) => setTimeout(r, 12000));
const out = await c.page.evaluate(`(() => {
  // Per-top-level-child drawable census — which system owns the draws.
  const scene = window.__scene;
  const rows = [];
  scene.children.forEach((c, i) => {
    let draws = 0, skinned = 0, inst = 0, tris = 0;
    c.traverse(o => {
      if (o.isSkinnedMesh) { draws++; skinned++; }
      else if (o.isInstancedMesh) { draws++; inst++; }
      else if (o.isMesh || o.isPoints || o.isSprite || o.isLine) draws++;
      const g = o.geometry; if (g && (o.isMesh || o.isSkinnedMesh || o.isInstancedMesh)) tris += (g.index ? g.index.count : g.attributes.position?.count || 0) / 3;
    });
    if (draws) rows.push({ i, name: c.name || c.type, draws, skinned, inst, trisK: +(tris/1000).toFixed(1) });
  });
  rows.sort((a,b) => b.draws - a.draws);
  return { children: scene.children.length, rows: rows.slice(0, 45), totalDrawables: rows.reduce((s,r)=>s+r.draws,0), calls: window.__renderer.info.render.calls };
})()`);
console.log('SYSCEN', JSON.stringify(out));
await closeClient(c); stack.down();
