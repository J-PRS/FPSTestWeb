import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

// matchToken smoke: force-end a live match via the admin API, assert the
// signed receipt broadcasts and reaches the client's onMatchToken hook.
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=tok-0&bots=4&mode=ctf'));
await c.waitFor(`window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()`, 30000);
await c.page.evaluate(`window.__toks = []; window.__test.networkManager.onMatchToken = (tk) => window.__toks.push(tk)`);
const key = process.env.FPS_ADMIN_TOKEN ?? '';
const res = await fetch(`http://localhost:${stack.serverPort}/admin/end?room=tok-0`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}` },
});
console.log('ADMIN-END', res.status, await res.text());
await new Promise((r) => setTimeout(r, 2500));
const toks = await c.page.evaluate(`window.__toks`);
console.log('MATCH-TOKENS', JSON.stringify(toks, null, 1));
console.log('--- SERVER TAIL ---');
console.log(stack.serverLog().slice(-3000));
await closeClient(c); stack.down();
