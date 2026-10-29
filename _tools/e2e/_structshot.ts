// bastion structure check: close on a genhouse + katastand (mottle/seams/
// grime/dust), then a wide for the compound at distance.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=strshot&map=bastion&bots=0&net=ws'),
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
  // Alpha compound: genhouse at (-500,-48) scale 4 — stand 25m south
  // looking north at its lit face; katastand (-500,60) close-up second.
  await c.page.evaluate(tp(-500, -10, 6, Math.PI, -0.05));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/struct_close.png' });
  // Same compound from ~60m — the mid-range read.
  await c.page.evaluate(tp(-440, 30, 12, -2.0, -0.08));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/struct_mid.png' });
  console.log('struct shots saved');
  await closeClient(c);
} finally { await stack.down(); }
