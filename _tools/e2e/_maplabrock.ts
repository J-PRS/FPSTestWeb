// maplab +rock verb visual check — apply rocks, orbit to top-down, shoot.
import { launchClient, closeClient } from './browser.js';

const c = await launchClient('http://localhost:5400/maplab.html');
await c.page.waitForFunction('!!document.querySelector("canvas")', { timeout: 30000 }).catch(() => null);
await new Promise(r => setTimeout(r, 9000));
// Click +rock three times so several impacts land
for (let i = 0; i < 3; i++) {
  await c.page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === '+rock')?.click()`);
  await new Promise(r => setTimeout(r, 700));
}
await new Promise(r => setTimeout(r, 3000));
await c.page.screenshot({ path: '_tools/e2e/shots/maplab_rock.png' });
console.log('shot saved');
await closeClient(c);
