// hills grass audit: high vantage + ground level shots on the solo path.
import { launchClient, closeClient } from './browser.js';

const c = await launchClient('http://localhost:5400/index.html?map=hills&mode=dm&bots=0&server=offline');
await c.waitFor('window.__test && window.__test.player', 60000).catch(() => false);
await new Promise(r => setTimeout(r, 12000));
// Vantage: lift the player and look across — tiling reads from altitude.
await c.page.evaluate('window.__test.player.pos.y += 120; window.__test.player.pitch = -0.5;');
await new Promise(r => setTimeout(r, 1500));
await c.page.screenshot({ path: '_tools/e2e/shots/hills_high.png' });
await c.page.evaluate('window.__test.player.pitch = -0.15; window.__test.player.yaw += 1.2;');
await new Promise(r => setTimeout(r, 800));
await c.page.screenshot({ path: '_tools/e2e/shots/hills_mid.png' });
console.log('shots saved');
await closeClient(c);
