// _bruteshot.ts — posedump screenshots of the brute variant.
import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
import { mkdirSync } from 'node:fs';

const vite = spawn([process.platform === 'win32' ? 'npx.cmd' : 'npx', 'vite', '--port', '5457', '--strictPort'],
  { cwd: 'client', stdout: 'ignore', stderr: 'ignore' });
try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch('http://localhost:5457/')).ok) {break;} } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  mkdirSync('_tools/e2e/shots', { recursive: true });
  const states = process.argv.slice(2);
  const wanted = states.length ? states : ['idle', 'run', 'death'];
  for (const state of wanted) {
    const c = await launchClient(
      `http://localhost:5457/posedump.html?pmodel=${process.env.PMODEL || 'brute'}&state=${state}&t=0.5&gunArrow=1`, {});
    await c.page.waitForFunction('window.__ready === true', { timeout: 180000 });
    const clips = await c.page.evaluate('window.__clips');
    console.log(`${state}: ${clips.length} clips`);
    await c.page.screenshot({ path: `_tools/e2e/shots/${process.env.PMODEL || 'brute'}-${state}.png` });
    await closeClient(c);
  }
} finally { vite.kill(); }
