import { launchClient, closeClient } from './browser.ts';

// Live repro for "remotes stuck in dead reckoning": seat a headless client
// in the running headhunt room and sample per-remote interp internals.
const c = await launchClient(`http://localhost:5400/s/headhunt-1?server=localhost:8000&mode=headhunt&bots=10`);
await c.waitFor(`window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()`, 45000);
console.log('seated — polling sim/converge internals');
const dump = async (): Promise<void> => {
  const s = await c.page.evaluate(`(() => {
    const now = Date.now();
    const w = window.__test.world ?? window.__test;
    return [...w.remotePlayers].map(([id, rp]) => {
      const it = rp.interp;
      const net = it?.net;
      const snaps = net?.snapshots ?? [];
      const nw = snaps[snaps.length - 1];
      const wire = it?.lastServerPosition;
      const gap = wire ? Math.hypot(rp.position.x - wire.x, rp.position.y - wire.y, rp.position.z - wire.z) : -1;
      return {
        id: id.slice(4, 12),
        gapM: +gap.toFixed(1),
        sim: it?._simulating ?? null,
        conv: +(it?.convergeTimer ?? -1).toFixed(2),
        silentMs: it ? now - it.lastUpdateTime : -1,
        und: it?.underruns ?? null,
        atCap: net?.atExtCap ?? null,
        nSnaps: snaps.length,
        arrIv: net?.arrivalInterval | 0,
        viewLag: rp.viewLagMs | 0,
      };
    });
  })()`);
  console.log(JSON.stringify(s));
};
for (let i = 0; i < 10; i += 1) { await dump(); await new Promise(r => setTimeout(r, 4000)); }
await closeClient(c);
