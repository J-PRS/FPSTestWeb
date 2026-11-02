/* oxlint-disable no-console */
import { launchClient, closeClient } from './browser.ts';
const c = await launchClient(`http://localhost:5400/?server=ws://localhost:8000/ws`);
await c.waitFor(`window.__test && window.__test.player`, 40000);
const s = await c.page.evaluate(`(() => { const w = window.__test.world;
  const rp = w.remotePlayers;
  return { type: rp ? rp.constructor.name : 'null', size: rp?.entities?.size ?? -1,
    keys: rp?.entities ? [...rp.entities.keys()].slice(0,5) : [],
    players: window.__test.networkManager?.getPlayers?.()?.size ?? -1 }; })()`);
console.log(JSON.stringify(s));
await closeClient(c);
