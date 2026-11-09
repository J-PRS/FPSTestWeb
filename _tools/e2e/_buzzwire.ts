import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

// Buzzard wire verify: real client + real server, rimrock dm room with
// creatures enabled (FPS_ALLOW_CREATURES must be set on the runner env).
const stack = await upStack();
const c = await launchClient(`${stack.clientUrl('').replace('/?', '/s/buzrock?')}&map=rimrock&mode=dm&bots=6`);
await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 60000);
await c.waitFor(`t.entities && (t.entities.buzzards || []).length >= 1`, 120000)
  .catch(() => console.log('TIMEOUT waiting for buzzards'));
for (let i = 0; i < 10; i++) {
  const s = await c.page.evaluate(`(() => {
    const e = window.__test.entities;
    const b = (e.buzzards || []).filter((x) => !x.dead);
    return { b: b.length, states: b.map((x) => x.state).join(','), net: b.filter((x) => x.netDriven).length,
      room: window.__test.world?.room ?? window.__test.networkManager?.netRoom };
  })()`);
  console.log(`poll${i}`, JSON.stringify(s));
  if (s.b >= 3) break;
  await new Promise((r) => setTimeout(r, 5000));
}
await c.page.screenshot({ path: '_tools/e2e/buzzard-live.png' });
console.log('SERVERLOG\n' + stack.serverLog().split('\n').filter((l) => /buzrock|creature|Room created|join|Join|handshake/i.test(l)).join('\n'));
await closeClient(c); stack.down();
