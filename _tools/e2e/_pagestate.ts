import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const stack = await upStack();
const client = await launchClient(stack.clientUrl(`&room=escalade&bots=0&net=ws`));
try {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const s = await client.page.evaluate(`JSON.stringify({ hasTest: !!window.__test, hasPlayer: !!(window.__test && window.__test.player), title: document.title, body: document.body.innerText.slice(0, 200), url: location.href })`);
    console.log(`t=${(i + 1) * 10}s`, String(s));
  }
} finally { await closeClient(client); stack.down(); }
