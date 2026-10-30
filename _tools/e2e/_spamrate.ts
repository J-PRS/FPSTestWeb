// useProgram spam rate: per-frame or boot-only? Hook console.warn, count 10s.
import { launchClient, closeClient } from './browser.ts';
const client = await launchClient('http://localhost:5400/?mode=headhunt&map=rimrock&bots=16');
try {
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  const counts = await client.page.evaluate(`new Promise((resolve) => {
    let n = 0;
    const orig = console.warn;
    console.warn = function (...a) { if (String(a[0]).includes('useProgram')) { n++; } return orig.apply(this, a); };
    setTimeout(() => { console.warn = orig; resolve(n); }, 10000);
  })`);
  console.log('useProgram warnings in 10s:', counts);
} finally { await closeClient(client); }
