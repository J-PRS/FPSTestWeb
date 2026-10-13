import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=census-0&map=crossfire&bots=10&mode=ctf&noballs=1&nocreatures=1'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 5`, 20000);
await new Promise(r => setTimeout(r, 12000));
const out = await c.page.evaluate(`(() => {
  const scene = window.__scene;
  const noCull = [], walkableStatics = new Set();
  const chain = (o) => { const n=[]; for(let p=o;p&&p!==scene;p=p.parent) n.unshift(p.name||p.type); return n.join('>'); };
  scene.traverse(o => {
    if ((o.isMesh || o.isSkinnedMesh || o.isSprite || o.isLine || o.isPoints) && o.frustumCulled === false) {
      noCull.push({ name: o.name || o.type, path: chain(o).slice(-90) });
    }
  });
  return { noCull: noCull.slice(0, 60), count: noCull.length };
})()`);
console.log('NOCULL', JSON.stringify(out));
await closeClient(c); stack.down();
