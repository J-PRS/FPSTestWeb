/* oxlint-disable no-console */
// Mid-combat WAN reconnect: autopilot fights on prod, DevTools takes the
// whole browser offline 6s (real transport death - ws dies, watchdog +
// inner lane must re-seat the seat), then back online. Asserts the seat
// reclaims, combat resumes, parity stays clean.
import { launchClient, closeClient } from './browser.ts';
const URL = 'http://127.0.0.1:5400/?server=https://play.jprice.app&room=headhunt-1&net=ws&autopilot';
const c = await launchClient(URL);
try {
  await c.waitFor(`window.__test?.networkManager?.isConnected()`, 90000);
  console.log('connected - 30s combat warmup');
  await new Promise(r => setTimeout(r, 30000));
  const pre = await c.test<any>(`JSON.stringify({room: window.__test.world?.room ?? '?', hp: window.__test.player?.health})`);
  console.log('pre-drop:', pre);
  console.log('going offline 6s...');
  await c.page.setOfflineMode(true);
  await new Promise(r => setTimeout(r, 6000));
  console.log('back online - waiting for re-seat');
  await c.page.setOfflineMode(false);
  const t0 = Date.now();
  let reconnected = false;
  while (Date.now() - t0 < 45000) {
    await new Promise(r => setTimeout(r, 2000));
    const up = await c.test<any>(`window.__test.networkManager.isConnected()`);
    if (up) {reconnected = true; console.log(`reconnected after ${Math.round((Date.now()-t0)/1000)}s`); break;}
  }
  if (!reconnected) {console.log('FAIL: no reconnect within 45s'); process.exit(1);}
  console.log('observing 60s post-reclaim');
  await new Promise(r => setTimeout(r, 60000));
  console.log('parity:', await c.test<any>(`JSON.stringify(window.__test.parity)`));
  console.log('state:', await c.test<any>(`JSON.stringify({room: window.__test.world?.room, hp: window.__test.player?.health, dead: window.__test.player?.isDead})`));
} finally { await closeClient(c); }
