import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=census-0&map=crossfire&bots=10&mode=ctf&noballs=1&nocreatures=1'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 5`, 20000);
await new Promise(r => setTimeout(r, 15000));
const out = await c.page.evaluate(`(() => {
  const scene = window.__scene, r = window.__renderer;
  const stats = { objs: 0, skinned: 0, instanced: 0, frustumOff: 0, autoMatrixOn: 0, bones: 0, mats: new Set(), geoms: 0, staticFrozen: 0 };
  const byType = {};
  scene.traverse(o => {
    stats.objs++;
    byType[o.type] = (byType[o.type] || 0) + 1;
    if (o.isSkinnedMesh) { stats.skinned++; stats.bones += o.skeleton?.bones?.length || 0; }
    if (o.isInstancedMesh) stats.instanced++;
    if (o.frustumCulled === false && (o.isMesh || o.isSkinnedMesh || o.isGroup)) stats.frustumOff++;
    if (o.matrixAutoUpdate !== false) stats.autoMatrixOn++; else stats.staticFrozen++;
    if (o.isMesh || o.isSkinnedMesh) { stats.geoms++; (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => stats.mats.add(m.uuid)); }
  });
  const top = Object.entries(byType).sort((a,b) => b[1]-a[1]).slice(0,12);
  return { ...stats, mats: stats.mats.size, topTypes: top, draws: r.info.render.calls, tris: r.info.render.triangles, remotes: window.__test.world.remotePlayers.entities.size };
})()`);
console.log('CENSUS', JSON.stringify(out));
await closeClient(c); stack.down();
