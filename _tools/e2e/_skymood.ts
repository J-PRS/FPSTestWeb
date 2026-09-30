// _skymood.ts — bloom compare: wait for real game time, not wall time.
import { upStack } from './env.js';
import { launchClient, closeClient } from './browser.js';

const stack = await upStack();
for (const [name, url] of [['nobloom', '&bots=0&yaw=-90&pitch=40'], ['bloom', '&bots=0&yaw=-90&pitch=40&bloom=on']]) {
  const c = await launchClient(stack.clientUrl(url));
  // SwiftShader runs ~7x slower than game time — the spawn fade-out reads
  // as a black screen until the match timer actually advances.
  const conn = await c.waitFor(`t.networkManager && t.networkManager.isConnected() && t.networkManager.lastTickSeq > 30`, 90000)
    .then(() => true).catch(() => false);
  console.log(name, 'connected:', conn);
  await new Promise(r => setTimeout(r, 8000));
  await c.page.screenshot({ path: `_tools/e2e/shots/${name}.png` });
  console.log(name, 'shot saved');
  await closeClient(c);
}
await stack.down();
console.log('done');
