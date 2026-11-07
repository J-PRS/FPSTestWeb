import { launchClient, closeClient } from './browser.ts';
const c = await launchClient('http://127.0.0.1:5500/?debug&server=https%3A%2F%2Fplay.jprice.app&room=headhunt-1');
try {
  await new Promise(r => setTimeout(r, 45000));
  const out = await c.test(`(()=>{const t=window.__test;if(!t)return 'no-test';const nm=t.networkManager;return JSON.stringify({conn: nm?.isConnected?.() ?? null, tier: nm?.getTransportTier?.() ?? null});})()`);
  console.log('PROBE:', out);
} finally { await closeClient(c); }
