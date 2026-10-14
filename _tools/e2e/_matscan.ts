import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=matscan&map=crossfire&bots=10&mode=ctf&noballs=1&nocreatures=1'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 5`, 20000);
await new Promise(r => setTimeout(r, 12000));
const out = await c.page.evaluate(`(() => {
  const scene = window.__scene;
  const inst = new Map(); // type -> count of material objects
  const matList = new Set();
  scene.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh && !o.isSprite && !o.isPoints && !o.isLine) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
      if (!m) return;
      matList.add(m.uuid);
      inst.set(m.type, (inst.get(m.type) || 0) + 1);
    });
  });
  const progs = new Set(window.__renderer.info.programs?.map(p => p.name || p.id) || []);
  return { materialInstances: matList.size, byType: [...inst.entries()].sort((a,b)=>b[1]-a[1]), programs: progs.size, progNames: [...progs].slice(0,30) };
})()`);
console.log('MATSCAN', JSON.stringify(out));
await closeClient(c); stack.down();
