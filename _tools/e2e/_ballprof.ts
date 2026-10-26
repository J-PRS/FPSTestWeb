import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';
// Offline classic-ish boot (no room → local ball authority) + ?ballprof —
// samples the 'balls' collectDiag section so we get the per-phase split
// (net/render/rage/shadow/inst/trails) against a real population.
const stack = await upStack();
const c = await launchClient(stack.clientUrl('&ballprof&debug'));
await c.waitFor(`t.player`, 30000);
for (let i = 0; i < 6; i += 1) {
  await new Promise((r) => setTimeout(r, 15000));
  const d = await c.page.evaluate(`(() => {
    const td = window.__trailDump?.() ?? {};
    const perf = window.__perf?.() ?? {};
    return { balls: td.balls ?? null, ballDots: td.ballDots ?? null, n: td.balls?.live ?? null, phase: { balls: perf.balls, frame: perf.frame, 'w:balls': perf['w:balls'], 'w:frame': perf['w:frame'] } };
  })()`);
  console.log(JSON.stringify(d));
}
await closeClient(c); stack.down();
