// Ball soak on a loaded map — drop probe balls, run N secs, dump HUD stats.
// MAP=broadside_t1 SECS=15 bun _tools/e2e/_ballsoak.ts
import { launchClient, closeClient } from './browser.js';
const map = process.env.MAP ?? 'broadside_t1';
const secs = Number(process.env.SECS ?? 15);
const c = await launchClient('http://localhost:5400/maplab.html');
await c.page.waitForFunction('!!document.querySelector("canvas")', { timeout: 30000 }).catch(() => null);
await c.page.evaluate(`localStorage.setItem("maplab", JSON.stringify({map:"${map}",verbs:[]}))`);
await c.page.evaluate(`localStorage.setItem("fps-wpos", "1")`); // WPOS ball trails under test
await c.page.reload();
await c.page.waitForFunction('!!document.querySelector("canvas")', { timeout: 30000 }).catch(() => null);
await new Promise(r => setTimeout(r, 10000));
await c.page.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('balls'))?.click()`);
await new Promise(r => setTimeout(r, secs * 1000));
const hud = await c.page.evaluate(`document.querySelectorAll('div')[ [...document.querySelectorAll('div')].findIndex(d => d.textContent?.startsWith('balls')) ]?.textContent`);
console.log(`=== ${map} ballsoak (${secs}s) ===\n${hud}`);
const wpos = await c.page.evaluate(`JSON.stringify(window.__wposDiag)`);
console.log(`wposDiag: ${wpos}`);
await c.page.screenshot({ path: `_tools/e2e/shots/soak_${map}.png` });
await closeClient(c);
