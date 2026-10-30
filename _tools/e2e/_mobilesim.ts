// Phone-class CPU profiling on PC: CDP CPU throttle (~5× slowdown ≈
// mid-tier mobile core) + __perf phase table + rAF frame stats in a
// SERVER match (real remotes, no offline-bot CPU — the honest client
// load). Usage: bun _tools/e2e/_mobilesim.ts [rate] [secs]
import { launchClient, closeClient } from './browser.ts';

const RATE = Number(process.argv[2] ?? 5);   // CPU throttle multiplier
const SECS = Number(process.argv[3] ?? 20);

const client = await launchClient('http://localhost:5400/quickjoin?server=127.0.0.1:8000&mode=ctf&bots=16');
try {
  const session = await client.page.createCDPSession();
  await session.send('Emulation.setCPUThrottlingRate', { rate: RATE });
  await client.page.waitForFunction('window.__test && window.__test.player', { timeout: 120000 });
  // rAF frame recorder — survives throttling, real inter-frame deltas.
  await client.page.evaluate(`(() => {
    window.__f = { n: 0, sum: 0, gaps: [], t0: 0 };
    let last = 0;
    const step = (t) => {
      if (last) { const d = t - last; window.__f.n++; window.__f.sum += d; window.__f.gaps.push(d); }
      last = t; requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })()`);
  await new Promise(r => setTimeout(r, SECS * 1000));
  const stats = await client.page.evaluate(`(() => {
    const f = window.__f || { n: 0, sum: 0, gaps: [] };
    const g = [...f.gaps].sort((a, b) => a - b);
    const p = (q) => g.length ? +g[Math.floor(g.length * q)].toFixed(1) : 0;
    const perf = window.__perf ? window.__perf() : {};
    return JSON.stringify({
      fps: f.sum ? +(f.n / (f.sum / 1000)).toFixed(1) : 0,
      p50: p(0.5), p95: p(0.95), frames: f.n,
      perf,
    });
  })()`);
  console.log(`throttle=${RATE}x secs=${SECS}s`, stats);
} finally { await closeClient(client); }
