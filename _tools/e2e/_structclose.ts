// structSurface close-up verification — right against the katastand
// wall face on bastion (lit side), plus an oblique for seams/grime.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=sclose&map=bastion&bots=0&net=ws'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await c.waitFor('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', 90000);
  await c.waitFor('window.__test.terrain && isFinite(window.__test.terrain.getHeight(0,0))', 60000);
  await new Promise(r => setTimeout(r, 5000));
  const tp = (x: number, z: number, up: number, yaw: number, pitch: number) =>
    `(() => { const p = window.__test.player;
      const h = window.__test.terrain.getHeight(${x}, ${z});
      p.pos.set(${x}, h + ${up}, ${z}); p.vel.set(0,0,0);
      p.yaw = ${yaw}; p.pitch = ${pitch};
      p.syncMovement && p.syncMovement(); p.markTeleport && p.markTeleport(); })()`;
  // Katastand at (-500,60) scale2 — body ~13m wide. Face-on at ~7m:
  // stand at z=67 looking north (-z... yaw PI faced -z toward z=60? No:
  // yaw PI faces -z; the stand is at z=60 north of z=67? lower z IS north
  // in this frame — face -z).
  await c.page.evaluate(tp(-500, 67, 3, Math.PI, 0.0));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/struct_wall.png' });
  // Oblique across the face for seams + grime + dust on top edges.
  await c.page.evaluate(tp(-504, 66, 3.5, 2.6, -0.15));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/struct_oblique.png' });
  console.log('close shots saved');
  await closeClient(c);
} finally { await stack.down(); }
