// envmap cost: same bastion vantage, RenderPass GPU with scene.environment
// set vs cleared. The env is one extra texture fetch/pixel on standard
// materials — measure whether it shows.
import { upStack } from './env.ts';
import { launchClient, closeClient } from './browser.ts';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&room=envperf&map=bastion&bots=0&net=ws&gpuperf=1'),
    { preload: "localStorage.setItem('fps-autoq','false')" });
  await c.waitFor('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', 90000);
  await c.waitFor('window.__test.terrain && isFinite(window.__test.terrain.getHeight(0,0))', 60000);
  await c.waitFor('window.__gpuPass', 30000);
  await new Promise(r => setTimeout(r, 5000));
  const h = await c.page.evaluate('window.__test.terrain.getHeight(-500, 72)');
  await c.page.evaluate(`(() => { const p = window.__test.player;
    p.pos.set(-500, ${h + 3.5}, 72); p.vel.set(0,0,0); p.yaw = Math.PI; p.pitch = -0.05;
    p.syncMovement && p.syncMovement(); p.markTeleport && p.markTeleport(); })()`);
  await new Promise(r => setTimeout(r, 2500));

  // rAF fps over ~3s — env adds one CubeUV fetch/pixel on standard mats.
  const read = async (): Promise<number> =>
    c.page.evaluate('new Promise(function (res) { var n = 0; function t() { n++; n < 180 ? requestAnimationFrame(t) : res(n / 3); } requestAnimationFrame(t); })');

  const on = await read();
  console.log('env ON  fps ~', on.toFixed(1));

  await c.page.evaluate('window.__test.scene.environment = null; window.__test.scene.environmentIntensity = 0;');
  await new Promise(r => setTimeout(r, 2500));
  const off = await read();
  console.log('env OFF fps ~', off.toFixed(1));

  await closeClient(c);
} finally { await stack.down(); }
