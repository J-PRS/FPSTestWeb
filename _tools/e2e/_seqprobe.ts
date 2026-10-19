/** _seqprobe.ts — sample lastTickSeq deltas to see the gap pattern. */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=soak&bots=10&net=ws'));
try {
  await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  const deltas = await c.test<{ deltas: number[] }>(`(() => {
    return new Promise(res => {
      const nm = t.networkManager;
      const arr = [];
      let last = nm.wireIn ? nm.wireIn.tickSeq : -1;
      const iv = setInterval(() => {
        const s = nm.wireIn ? nm.wireIn.tickSeq : -1;
        if (s >= 0 && last >= 0) arr.push(s - last);
        last = s;
      }, 50);
      setTimeout(() => { clearInterval(iv); res({ deltas: arr }); }, 10000);
    });
  })()`);
  const hist: Record<number, number> = {};
  for (const d of deltas.deltas) hist[d] = (hist[d] ?? 0) + 1;
  console.log('delta histogram (per 50ms sample):', hist);
} finally { await closeClient(c); stack.down(); }
