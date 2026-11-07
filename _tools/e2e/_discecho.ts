/* oxlint-disable no-console */
// Disc-echo hunter: force the loadout to Disc (wid=1) on prod, autopilot
// fights, count wt:1 dmg-echo GLITCHes + parity census.
import { launchClient, closeClient } from './browser.ts';
const SECS = Number(process.argv[2] ?? '240');
const c = await launchClient(
  'http://127.0.0.1:5400/?server=https://play.jprice.app&room=headhunt-1&net=ws&autopilot');
try {
  await c.waitFor(`window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()`, 90000);
  const set = await c.test<any>(`(() => {
    const p = window.__test.player;
    for (let i = 0; i < p.loadout.length; i++) { p.armory.setLoadoutSlot(i, 1); }
    p.armory.setActiveSlot?.(0) ?? p.equipSlot?.(0);
    return JSON.stringify(p.loadout);
  })()`);
  console.log('loadout forced:', set, '- observing', SECS, 's');
  const t0 = Date.now();
  let echoes = 0;
  while (Date.now() - t0 < SECS * 1000) {
    await new Promise(r => setTimeout(r, 15000));
    const n = await c.test<any>(`(window.__test.parity?.misses ?? window.__trailDump?.().parity?.misses ?? '?')`);
    console.log(`t+${Math.round((Date.now()-t0)/1000)}s misses=${n}`);
  }
  const parity = await c.test<any>(`JSON.stringify(window.__test.parity ?? window.__trailDump?.().parity)`);
  console.log('parity:', parity);
} finally { await closeClient(c); }
