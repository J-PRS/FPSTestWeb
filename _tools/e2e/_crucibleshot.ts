// crucible check: rim vantage across the bowl, inside-the-bowl relief,
// and a top-down for the whole crater ring.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=cshot&map=crucible&bots=0&net=ws'),
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
  // On the alpha rim pad looking across the bowl at bravo — the DC sightline.
  await c.page.evaluate(tp(-290, 10, 8, -Math.PI / 2, -0.12));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/crucible_rim.png' });
  // Inside the bowl looking at the crag field / vent plug — relief check.
  await c.page.evaluate(tp(90, 60, 10, -2.4, -0.1));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/crucible_bowl.png' });
  // Top-down over the vent — ring, rays, sub-craters.
  await c.page.evaluate(tp(0, 0, 500, 0.0, -1.5));
  await new Promise(r => setTimeout(r, 1500));
  await c.page.screenshot({ path: '_tools/e2e/shots/crucible_top.png' });
  console.log('crucible shots saved');
  await closeClient(c);
} finally { await stack.down(); }
