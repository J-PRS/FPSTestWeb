// Dump the maplab minimap (hmview canvas incl. ball trails) as PNG.
import { launchClient, closeClient } from './browser.js';
import { writeFileSync } from 'node:fs';
const map = process.env.MAP ?? 'broadside_t1';
const secs = Number(process.env.SECS ?? 15);
const c = await launchClient('http://localhost:5400/maplab.html');
await c.page.waitForFunction('!!document.querySelector("canvas")', { timeout: 30000 }).catch(() => null);
await c.page.evaluate(`localStorage.setItem("maplab", JSON.stringify({map:"${map}",verbs:[]}))`);
await c.page.reload();
await c.page.waitForFunction('!!document.querySelector("canvas")', { timeout: 30000 }).catch(() => null);
await new Promise(r => setTimeout(r, 10000));
await c.page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('balls'))?.click()`);
await new Promise(r => setTimeout(r, secs * 1000));
const data = await c.page.evaluate(`document.querySelector('#hmview').toDataURL()`);
writeFileSync(`_tools/e2e/shots/hm_${map}.png`, Buffer.from((data as string).split(',')[1], 'base64'));
console.log(`hm_${map}.png saved`);
await closeClient(c);
