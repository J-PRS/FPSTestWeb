/* oxlint-disable no-console */
// Transport tier probe: launch with ?net=X, report negotiated tier over time.
import { launchClient, closeClient } from './browser.ts';
const NET = process.argv[2] ?? 'rtc';
const SECS = Number(process.argv[3] ?? '60');
const c = await launchClient(
  `http://127.0.0.1:5400/?server=https://play.jprice.app&room=headhunt-1&net=${NET}&autopilot`);
try {
  await c.waitFor(`window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()`, 90000);
  const t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000) {
    const s = await c.test<any>(`JSON.stringify({tier: window.__test.networkManager.ws?.tier, conn: window.__test.networkManager.isConnected()})`);
    console.log(`t+${Math.round((Date.now()-t0)/1000)}s ${s}`);
    await new Promise(r => setTimeout(r, 10000));
  }
} finally { await closeClient(c); }
