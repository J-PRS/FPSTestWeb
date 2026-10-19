import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
import { mkdirSync } from 'node:fs';

// Are inverted-hull outline meshes actually in the scene? Count BackSide
// skinned meshes + check the first remote's hull state.
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=hullprobe&map=crossfire&bots=10&mode=ctf&noballs=1&nocreatures=1'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 2`, 30000);
await new Promise((r) => setTimeout(r, 20000)); // models + anims settle
const probe = await c.page.evaluate(`(() => {
  const out = { backsideSkinned: 0, backsideMesh: 0, visibleHull: 0, remotes: [] };
  const seen = new Set();
  window.__scene.traverse((o) => {
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && m.side === 1 && m.type === 'MeshBasicMaterial') {
      if (o.isSkinnedMesh) { out.backsideSkinned++; } else { out.backsideMesh++; }
      if (o.visible && !seen.has(m)) { seen.add(m); out.visibleHull++; }
    }
  });
  for (const [id, rp] of window.__test.world.remotePlayers.entities) {
    const pm = rp.model;
    out.remotes.push({
      id, hulls: pm.hulls?.length, gunHulls: pm.gunHulls?.length,
      skinned: pm.skinnedMeshes?.length,
      hullVis: pm.hulls?.[0]?.visible,
      hullInScene: pm.hulls?.[0] ? (() => { let p = pm.hulls[0]; while (p.parent) { p = p.parent; } return p === window.__scene || p.type === 'Scene'; })() : null,
    });
  }
  return out;
})()`);
console.log('HULLPROBE', JSON.stringify(probe, null, 1));
mkdirSync('_tools/e2e/shots', { recursive: true });
await c.page.screenshot({ path: '_tools/e2e/shots/hullprobe.png' });
await closeClient(c); stack.down();
