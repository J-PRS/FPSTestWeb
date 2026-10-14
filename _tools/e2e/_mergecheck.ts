import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=mergechk&map=crossfire&bots=6&mode=ctf'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 3`, 20000);
await new Promise((r) => setTimeout(r, 12000));
const out = await c.page.evaluate(`(() => {
  const per = [];
  window.__test.world.remotePlayers.entities.forEach((rp) => {
    const m = rp.model?.object3D;
    const info = { id: rp.playerId, parts: [], merged: 0 };
    m?.traverse(o => { if (o.isSkinnedMesh) { info.parts.push(o.name || '?'); if (o.name.startsWith('merged:')) info.merged++; } });
    per.push(info);
  });
  return per;
})()`);
console.log('MERGECHK', JSON.stringify(out));
await closeClient(c); stack.down();
