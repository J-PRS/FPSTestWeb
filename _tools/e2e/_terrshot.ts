// terrain edge check: high-pitch view at the horizon — the outer clipmap
// ring alpha-dissolves into sky; that's the pass the transparent:true
// change moved. Two shots: horizon + a down-view across the field.
import { launchClient, closeClient } from '../e2e/browser.js';
import { upStack } from '../e2e/env.js';

const stack = await upStack();
try {
  const c = await launchClient(stack.clientUrl('&bots=0&yaw=0&pitch=-12'));
  await c.waitFor('t.networkManager && t.networkManager.isConnected() && t.networkManager.lastTickSeq > 30', 90000).catch(() => false);
  await new Promise(r => setTimeout(r, 6000));
  await c.page.screenshot({ path: '_tools/e2e/shots/terr_edge.png' });
  await c.page.evaluate('window.__test.player.pitch = -0.6; window.__test.player.yaw = 0.8');
  await new Promise(r => setTimeout(r, 1500));
  await c.page.screenshot({ path: '_tools/e2e/shots/terr_down.png' });
  console.log('shots saved');
  await closeClient(c);
} finally { await stack.down(); }
