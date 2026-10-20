// One-off: headless shot of the warhammer in the fist (vmdump w=fist).
// bun _tools/_hamshot.ts
import { launchClient, closeClient } from './e2e/browser.ts';

const c = await launchClient('http://localhost:5400/vmdump.html?w=fist&close=1&ao=off');
await c.page.waitForFunction('window.__ready === true', { timeout: 20000 });
await new Promise((r): void => { setTimeout(r, 1000); });
await c.page.screenshot({ path: '_tools/hammer_swing.png' });
await closeClient(c);
console.log('wrote _tools/hammer_swing.png');
