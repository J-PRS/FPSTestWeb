/** _wssoak.ts — real browser client, ws tier, live combat; sample Alt+Q
 *  metrics every 2s for N seconds, catch drops/stalls/coal spikes. */
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const SECS = Number(process.argv[2] ?? 120);
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&room=soak&bots=10&net=ws'));

let drops = 0, prevConn = true, maxLag = 0, maxCoalDelta = 0, prevCoal = 0, tickGaps = 0;
try {
  await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 30000);
  const t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await c.test<{
      conn: boolean; ping: number; loss: number; lag: number; coal: number;
      rtt: number; fps: number; corr: number;
    }>(`(() => {
      const nm = t.networkManager;
      const p = nm.netProbe;
      return { conn: nm.isConnected(), ping: nm.getPing(), loss: nm.getPacketLoss(),
        lag: p?.lagMs ?? -1, coal: p?.coalesced ?? 0, rtt: p?.rttMs ?? -1,
        fps: Math.round(t.perf?.fps ?? 0), corr: nm.netprobe?.corrections ?? -1 };
    })()`);
    if (!s.conn && prevConn) drops += 1;
    if (s.conn && !prevConn) console.log(`  [rejoined t=${((Date.now()-t0)/1000).toFixed(0)}s]`);
    prevConn = s.conn;
    maxLag = Math.max(maxLag, s.lag);
    maxCoalDelta = Math.max(maxCoalDelta, s.coal - prevCoal);
    prevCoal = s.coal;
    if (!s.conn || s.lag > 80 || s.coal - prevCoal > 0 || s.loss > 2)
      console.log(`  t=${((Date.now()-t0)/1000).toFixed(0)}s ${JSON.stringify(s)}`);
  }
  console.log(`RESULT drops=${drops} maxLagMs=${maxLag} maxCoalPer2s=${maxCoalDelta}`);
} finally {
  await closeClient(c);
  stack.down();
}
