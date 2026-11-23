import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stack = await upStack();
const client = await launchClient(stack.clientUrl('&mode=classic&map=ballroom'));
try {
  await client.waitFor('t.player && t.terrain && isFinite(t.terrain.getHeight(0,0))', 90000);
  await sleep(8000);
  const d = await client.test(`(() => { const t = window.__test; return {
    balls: t.world.balls?.length ?? 'none',
    ballLive: (window.__ballLive ?? 'n/a'),
    connected: t.networkManager?.isConnected?.() ?? 'n/a',
    mode: t.mode ?? 'n/a',
    soloMode: t.soloMode ?? 'n/a',
    keys: Object.keys(t.world).filter(k => /ball|zone/i.test(k)),
  }; })()`);
  console.log(JSON.stringify(d, null, 1));
} finally {
  await closeClient(client);
  await stack.down();
}
