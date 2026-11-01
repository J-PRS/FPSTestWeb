// Video-record cost A/B: rAF frame times before vs during rolling
// capture, plus the recorder's own pump/blit/qMax stats from console.
// bun _tools/e2e/_vidprof.ts  (E2E_GPU=1 or E2E_HEADED=1 for real GL)
import { launchClient, closeClient } from './browser.ts';
import { upStack } from './env.ts';

const PRE = 10, REC = 20;
const INJECT = `(() => { const w = window; if (w.__vp) return; w.__vp = { frames: [] };
  let last = performance.now();
  const tick = () => { const n = performance.now(); w.__vp.frames.push(n - last);
    if (w.__vp.frames.length > 8192) w.__vp.frames.splice(0, 4096); last = n; requestAnimationFrame(tick); };
  requestAnimationFrame(tick); })()`;
const DRAIN = `(() => { const w = window; const f = w.__vp.frames.splice(0);
  f.sort((a,b)=>a-b); const s=f.reduce((a,b)=>a+b,0);
  return { n:f.length, avg:f.length?s/f.length:0, p50:f[Math.floor(f.length*.5)]||0,
    p95:f[Math.floor(f.length*.95)]||0, max:f[f.length-1]||0 }; })()`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pct = (s: { avg: number }): string => (s.avg * 1000).toFixed(0);

const FALLBACK = process.argv.includes('--fallback');
const stack = await upStack();
let c: Awaited<ReturnType<typeof launchClient>> | null = null;
try {
  c = await launchClient(stack.clientUrl('&room=vidprof&map=rimrock&mode=ctf&bots=8&autopilot'));
  // --fallback: kill WebCodecs pre-load so VideoRecorder takes the
  // captureStream+MediaRecorder (CPU encode) path instead.
  if (FALLBACK) {
    await c.page.evaluateOnNewDocument('Object.defineProperty(window, "VideoEncoder", { get: () => undefined });');
    console.log('fallback forced: VideoEncoder hidden');
    await c.page.reload({ waitUntil: 'domcontentloaded' });
  }
  c.page.on('console', (m) => { if (m.text().includes('rec stats') || m.text().includes('rec done')) {console.log('  ' + m.text());} });
  await c.page.evaluate(INJECT);
  await c.waitFor(`t.networkManager && t.networkManager.isConnected()`, 45000);
  await c.waitFor(`window.__demoManager`, 10000);
  await sleep(3000); // warm

  await c.page.evaluate('window.__vp.frames.length = 0');
  await sleep(PRE * 1000);
  const pre = await c.page.evaluate(DRAIN) as Record<string, number>;
  console.log(`baseline ${PRE}s: n=${pre.n} avg=${pre.avg.toFixed(2)}ms p50=${pre.p50.toFixed(1)} p95=${pre.p95.toFixed(1)} max=${pre.max.toFixed(1)}`);

  await c.page.evaluate('window.__vp.frames.length = 0');
  const started = await c.page.evaluate(`(async () => { const dm = window.__demoManager; return await dm['startVideoCapture'](); })()`);
  console.log(`startVideoCapture → ${started}`);
  for (let i = 0; i < REC / 2; i += 1) {
    await sleep(2000);
    const s = await c.page.evaluate(`(() => { const v = window.__demoManager.video;
      return { st: v['enc']?.state, q: v['enc']?.encodeQueueSize, ring: v['ring'].length,
        frames: v['frames'], failed: v['encFailed'] }; })()`);
    console.log(`  rec t=${(i + 1) * 2}s state=${JSON.stringify(s)}`);
  }
  const rec = await c.page.evaluate(DRAIN) as Record<string, number>;
  console.log(`recording ${REC}s: n=${rec.n} avg=${rec.avg.toFixed(2)}ms p50=${rec.p50.toFixed(1)} p95=${rec.p95.toFixed(1)} max=${rec.max.toFixed(1)}`);

  const hw = await c.page.evaluate(`(() => { const dm = window.__demoManager; return { hw: dm.video.usingHardware, mime: dm.video.mimeType }; })()`);
  console.log(`encoder: ${JSON.stringify(hw)}`);
  console.log(`delta avg=${(rec.avg - pre.avg).toFixed(2)}ms (${pct(pre)}µs → ${pct(rec)}µs frame time)`);
  const dbg = await c.page.evaluate(`(() => { const dm = window.__demoManager; const v = dm.video;
    const ring = v['ring']; const now = performance.now();
    const keys = ring.filter(r => r.c.type === 'key').length;
    return { n: ring.length, keys, first: ring[0]?.ts, last: ring[ring.length-1]?.ts, now,
      startMs: now - 5000, encNull: !v['enc'], encWall: v['encWall'] }; })()`);
  console.log(`ring debug: ${JSON.stringify(dbg)}`);
  const cut = await c.page.evaluate(`(async () => { const dm = window.__demoManager;
    const now = performance.now(); const b = await dm.video.cutWindow(now - 5000, now);
    return { size: b ? b.size : 0, lastCut: dm.video.lastCut }; })()`)
    .then(r => r as { size: number; lastCut: unknown });
  console.log(`cutWindow → ${(cut.size / 1e6).toFixed(1)}MB lastCut=${JSON.stringify(cut.lastCut)}`);
  const stats = await c.page.evaluate(`(() => window.__demoManager.video.stats)()`);
  console.log(`rec stats: ${JSON.stringify(stats)}`);
  const stop = await c.page.evaluate(`(async () => { const b = await window.__demoManager.video.stop(); return b ? b.size : 0; })()`);
  console.log(`stop → ${((stop as number) / 1e6).toFixed(1)}MB`);
} finally {
  if (c) {await closeClient(c);}
  await stack.down();
}
