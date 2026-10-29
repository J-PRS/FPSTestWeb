// wyrd look check: ground-level, high vantage, and top-down shots.
// Uses pos.set + markTeleport (mapshot.ts pattern) so the jumps stick.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=wyrdshot&map=wyrd&bots=0&mode=dm&net=ws'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await c.waitFor('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', 90000);
  await new Promise(r => setTimeout(r, 12000));
  await c.page.screenshot({ path: '_tools/e2e/shots/wyrd_ground.png' });
  const tp = (x: number, z: number, up: number, yaw: number, pitch: number) =>
    `(() => { const p = window.__test.player;
      const h = window.__test.terrain?.heightAt ? window.__test.terrain.heightAt(${x}, ${z}) : 60;
      p.pos.set(${x}, h + ${up}, ${z}); p.vel.set(0,0,0);
      p.yaw = ${yaw}; p.pitch = ${pitch};
      p.syncMovement && p.syncMovement(); p.markTeleport && p.markTeleport(); })()`;
  // High vantage over map centre, looking down ~55° — flats + slopes +
  // horizon, the view that judges the meadow hue regions.
  await c.page.evaluate(tp(0, 0, 130, 0.6, -0.95));
  await new Promise(r => setTimeout(r, 2000));
  await c.page.screenshot({ path: '_tools/e2e/shots/wyrd_high.png' });
  // Near top-down for the palette patchwork.
  await c.page.evaluate(tp(0, 0, 300, 0.0, -1.45));
  await new Promise(r => setTimeout(r, 1500));
  await c.page.screenshot({ path: '_tools/e2e/shots/wyrd_top.png' });
  console.log('shots saved');
  await closeClient(c);
} finally { await stack.down(); }
