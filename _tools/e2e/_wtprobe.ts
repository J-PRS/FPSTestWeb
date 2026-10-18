/** _wtprobe.ts — which tier does the ladder land on now? */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const want = process.argv[2] ?? 'wt';
const stack = await upStack();
const url = stack.clientUrl(`&room=e2ewt&bots=0&net=${want}`);
const c = await launchClient(url);
try {
  await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  await new Promise((r) => setTimeout(r, 4000));
  const tier = await c.test<string>(`t.networkManager.transportTier ?? t.networkManager.ws?.tier`);
  console.log('RESULT tier:', tier);
} finally {
  await closeClient(c);
  stack.down();
}
