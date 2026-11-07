/* oxlint-disable no-console */
// kb-echo rate probe: 2-client PvP on prod, sample RTT, count GLITCH lines.
import { launchClient, closeClient } from './browser.ts';
const SECS = Number(process.argv[2] ?? '300');
const URL = 'http://127.0.0.1:5400/?server=https://play.jprice.app&room=headhunt-1&net=ws&autopilot';
const a = await launchClient(URL);
const b = await launchClient(URL);
try {
  await a.waitFor(`window.__test?.networkManager?.isConnected()`, 90000);
  await b.waitFor(`window.__test?.networkManager?.isConnected()`, 90000);
  console.log('both connected - observing', SECS, 's');
  const t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000) {
    await new Promise(r => setTimeout(r, 30000));
    const ping = await a.test<any>(`JSON.stringify({ping: window.__test.networkManager.getPing?.(), srv: window.__test.networkManager.serverPingMs})`);
    console.log(`t+${Math.round((Date.now()-t0)/1000)}s ${ping}`);
  }
  console.log('A parity:', await a.test<any>(`JSON.stringify(window.__test.parity)`));
  console.log('B parity:', await b.test<any>(`JSON.stringify(window.__test.parity)`));
} finally { await closeClient(a); await closeClient(b); }
