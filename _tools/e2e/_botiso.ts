import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

// Bot-only CPU isolate: real client in a room with NO balls and NO
// creatures — everything left is bots + player + render + net.
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=botiso-0&map=crossfire&bots=10&mode=ctf&noballs=1&nocreatures=1'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 1`, 20000);
await new Promise((r) => setTimeout(r, 30000)); // steady state
const out = await c.page.evaluate(`({ remotes: window.__test.world.remotePlayers.entities.size, perf: window.__perf() })`);
console.log('BOT-ISO', JSON.stringify(out, null, 1));
await closeClient(c); stack.down();
