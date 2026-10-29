// airarena check: arena panel grid in daylight — kit pieces on the
// patched standard mats. Panels at (-48, -48..36).
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=ashot&map=airarena&bots=0&net=ws'),
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
  // On the panel grid looking along it — close-range surface detail.
  await c.page.evaluate(tp(-48, 20, 5, Math.PI, -0.25));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/struct_panels.png' });
  // Wide over the grid.
  await c.page.evaluate(tp(-48, 0, 80, Math.PI / 2, -0.7));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/struct_grid.png' });
  console.log('airarena shots saved');
  await closeClient(c);
} finally { await stack.down(); }
