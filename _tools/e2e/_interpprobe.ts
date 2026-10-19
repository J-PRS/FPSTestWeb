import { launchClient, closeClient } from './browser.ts';

const c = await launchClient(`http://localhost:5400/s/dualtest4?server=localhost:8000&mode=ctf&bots=8`);
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
      const gap = nw ? Math.hypot(rp.position.x - nw.x, rp.position.y - nw.y, rp.position.z - nw.z) : -1;
      return {
        id,
        gap: gap | 0,
        pos: [rp.position.x | 0, rp.position.y | 0, rp.position.z | 0],
        sim: it?._simulating ?? null,
        conv: it?.convergeTimer?.toFixed(2) ?? null,
        pred: it?.predictionTimer?.toFixed(2) ?? null,
        simVel: it?.simulatedVelocity ? [it.simulatedVelocity.x | 0, it.simulatedVelocity.y | 0, it.simulatedVelocity.z | 0] : null,
        lastSrv: it?.lastServerPosition ? [it.lastServerPosition.x | 0, it.lastServerPosition.y | 0, it.lastServerPosition.z | 0] : null,
        newest: nw ? [nw.x | 0, nw.y | 0, nw.z | 0] : null,
        nSnaps: snaps.length,
        arrIv: net?.arrivalInterval | 0,
      };
    });
  })()`);
  console.log(JSON.stringify(s));
};
for (let i = 0; i < 5; i += 1) { await dump(); await new Promise(r => setTimeout(r, 3000)); }
await closeClient(c);
