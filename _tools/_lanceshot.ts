// One-off: headless shot of the Shocklance viewmodel (wt 38).
// bun _tools/_lanceshot.ts
import { launchClient, closeClient } from './e2e/browser.ts';

const c = await launchClient('http://localhost:5400/vmdump.html?w=38&close=1&ao=off');
await c.page.waitForFunction('window.__ready === true', { timeout: 20000 });
// The GLB bake swap lands async — give it a beat, then shoot.
await new Promise((r): void => { setTimeout(r, 1500); });
await c.page.screenshot({ path: '_tools/lance_w38.png' });
await closeClient(c);
console.log('wrote _tools/lance_w38.png');
