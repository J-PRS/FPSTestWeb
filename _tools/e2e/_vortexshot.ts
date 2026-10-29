// vortex check: preset-7 crag palette — ground in the hollows, high oblique,
// top-down for the moss/scree/slate layout.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=vshot&map=vortex&bots=0&net=ws'),
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
  await c.page.evaluate(tp(120, 60, 8, -1.9, -0.08));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/vortex_ground.png' });
  await c.page.evaluate(tp(0, 0, 160, -0.6, -0.55));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/vortex_high.png' });
  await c.page.evaluate(tp(0, 0, 380, 0.0, -1.5));
  await new Promise(r => setTimeout(r, 1500));
  await c.page.screenshot({ path: '_tools/e2e/shots/vortex_top.png' });
  console.log('vortex shots saved');
  await closeClient(c);
} finally { await stack.down(); }
