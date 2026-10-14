import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

// 16x CPU throttle probe — find the real hotspots under extreme slowdown.
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=throttle16&map=crossfire&bots=10&mode=ctf'));
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
await c.waitFor(`t.world.remotePlayers.entities.size >= 5`, 20000);
await new Promise(r => setTimeout(r, 12000)); // steady state at 1x

const cdp = await (c.page as any).createCDPSession();
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await new Promise(r => setTimeout(r, 15000)); // throttle stabilizes

const perf = await c.page.evaluate(`window.__perf()`);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
console.log('THROTTLE16', JSON.stringify(perf));
await closeClient(c); stack.down();
