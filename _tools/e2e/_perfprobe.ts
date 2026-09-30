import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=perfprobe&bots=8'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await new Promise((r) => setTimeout(r, 15000));
console.log(JSON.stringify(await c.page.evaluate(`window.__perf()`), null, 0));
await closeClient(c); stack.down();
