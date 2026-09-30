// _skymood.ts — visual check: boot a client aimed sunward, screenshot.
import { upStack } from './env.js';
import { launchClient, closeClient } from './browser.js';

const stack = await upStack();
const c = await launchClient(stack.clientUrl('&bots=0&yaw=-90&pitch=40'));
await new Promise(r => setTimeout(r, 30000));
const diag = await c.page.evaluate(`(() => {
  const t = window.__test;
  return JSON.stringify({
    hasTest: !!t,
    conn: !!(t && t.networkManager && t.networkManager.isConnected()),
    seq: t && t.networkManager ? t.networkManager.lastTickSeq : null,
    keys: t ? Object.keys(t) : [],
  });
})()`);
console.log('diag:', diag);
await c.page.screenshot({ path: '_tools/e2e/shots/sunward.png' });
console.log('shot saved');
await closeClient(c);
await stack.down();
console.log('done');
