// maplab field screenshot — verify terrain gen visuals (seams, presets).
import { launchClient, closeClient } from './browser.js';

const url = process.env.MAPLAB_URL ?? 'http://localhost:5400/maplab.html';
const c = await launchClient(url);
await c.page.waitForFunction('!!document.querySelector("canvas")', { timeout: 30000 }).catch(() => null);
await new Promise(r => setTimeout(r, 12000));
await c.page.screenshot({ path: '_tools/e2e/shots/maplab.png' });
console.log('shot saved');
await closeClient(c);
