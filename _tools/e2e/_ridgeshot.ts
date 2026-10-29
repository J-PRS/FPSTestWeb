// ridges check: primitive wall/box structures in daylight — the spec-mat
// path (Lambert + structSurface), not the kit path.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=rshot&map=ridges&bots=0&net=ws'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await c.waitFor('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', 90000);
  await c.waitFor('window.__test.terrain && isFinite(window.__test.terrain.getHeight(0,0))', 60000);
  await new Promise(r => setTimeout(r, 6000));
  const tp = (x: number, z: number, up: number, yaw: number, pitch: number) =>
    `(() => { const p = window.__test.player;
      const h = window.__test.terrain.getHeight(${x}, ${z});
      p.pos.set(${x}, h + ${up}, ${z}); p.vel.set(0,0,0);
      p.yaw = ${yaw}; p.pitch = ${pitch};
      p.syncMovement && p.syncMovement(); p.markTeleport && p.markTeleport(); })()`;
  // Walls cluster around (-85,-75) — stand SE of them looking NW.
  await c.page.evaluate(tp(-60, -50, 4, 2.4, -0.05));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/ridges_structs.png' });
  // Close on a wall face for the seam/mottle read.
  await c.page.evaluate(tp(-82, -62, 3, 2.8, 0.0));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/ridges_close.png' });
  console.log('ridges shots saved');
  await closeClient(c);
} finally { await stack.down(); }
