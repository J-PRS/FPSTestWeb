// Phone profiler — attach to the game page on the USB-connected phone via
// CDP (adb forward tcp:9333 localabstract:chrome_devtools_remote), navigate
// it into a live ctf bot match, then sample Performance metrics + rAF fps +
// __test every 15s. One 15s devtools.timeline trace mid-run names the hot
// main-thread functions.   bun _tools/e2e/_phoneprof.ts [wallSecs]
import { chromium, type CDPSession } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const secs = Number(process.argv[2] ?? 90);
const browser = await chromium.connectOverCDP('http://localhost:9333');
const ctx = browser.contexts()[0];
if (!ctx) { console.log('no context'); process.exit(1); }
const page = ctx.pages().find(p => p.url().includes('localhost:5400'))
  ?? ctx.pages().find(p => p.type() === 'page');
if (!page) { console.log('no page target'); process.exit(1); }
console.log('attached:', page.url());
const cdp: CDPSession = await ctx.newCDPSession(page);
await cdp.send('Performance.enable');

// rAF frame-time recorder — survives navigation because every stats read
// recreates it when missing. Runs on the phone's real compositor.
const inject = `(() => { const w = window; if (w.__ph) return; w.__ph = { frames: [] }; let last = performance.now(); const tick = () => { const now = performance.now(); w.__ph.frames.push(now - last); if (w.__ph.frames.length > 4096) w.__ph.frames.splice(0, w.__ph.frames.length - 4096); last = now; requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`;
await page.addInitScript(inject);
if (page.url().includes('5400')) { await page.evaluate(inject); }

await page.waitForFunction('window.__test && window.__test.playerId', { timeout: 90000 })
  .catch(() => { console.log('WARN: no playerId within 90s — still on menu?'); });

const traceBuf: string[] = [];
cdp.on('Tracing.dataCollected', (data: { value?: { toString(): string }[] }) => {
  for (const e of data.value ?? []) { traceBuf.push(String(e)); }
});

const stats = async (): Promise<void> => {
  const m = (await cdp.send('Performance.getMetrics')).metrics as { name: string; value: number }[];
  const mm = Object.fromEntries(m.map(x => [x.name, x.value]));
  const s = await page.evaluate(() => {
    const w = window as unknown as { __ph: { frames: number[] }; __test?: Record<string, unknown> };
    const f = w.__ph ? w.__ph.frames.splice(0) : []; f.sort((a, b) => a - b);
    const t = (w.__test ?? {}) as Record<string, unknown>;
    return {
      fps: f.length ? Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length)) : 0,
      p50: f[Math.floor(f.length * .5)]?.toFixed(1), p95: f[Math.floor(f.length * .95)]?.toFixed(1),
      playerId: t.playerId, room: t.room, autoq: t.autoqLevel ?? t.gpuLevel, tickMs: t.tickMsAvg ?? t.tickMs,
    };
  });
  console.log(`  fps=${s.fps} p50=${s.p50}ms p95=${s.p95}ms  Heap=${((mm.JSHeapUsedSize ?? 0) / 1048576).toFixed(0)}MB Nodes=${mm.Nodes}  room=${s.room} pid=${String(s.playerId).slice(0, 18)} autoq=${JSON.stringify(s.autoq)} tick=${s.tickMs}`);
};

let traced = false;
for (let t = 0; t < secs; t += 15) {
  await new Promise(r => setTimeout(r, 15000));
  await stats();
  if (!traced && t + 15 >= 45) {
    traced = true;
    console.log('  tracing 15s…');
    traceBuf.length = 0;
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing', transferMode: 'ReportEvents' });
    await new Promise(r => setTimeout(r, 15000));
    await cdp.send('Tracing.end');
    await new Promise(r => setTimeout(r, 2000)); // flush trailing dataCollected
    writeFileSync('_phone_trace.jsonl', traceBuf.join(''));
    // Aggregate self-time per function-ish event name.
    const selfTime = new Map<string, number>();
    for (const chunk of traceBuf) {
      try {
        for (const e of JSON.parse(`[${chunk.replace(/\]\s*\[|\}\s*\{/g, '},{')}]`.replace(/^\[,|,\]$/g, '') + '') as { name?: string; ph?: string; dur?: number }[]) { /* noop */ }
      } catch { /* chunk isn't clean json — parse below instead */ }
      for (const m of chunk.matchAll(/"name"\s*:\s*"([^"]+)"[^{}]*"dur"\s*:\s*(\d+)/g)) {
        const n = m[1]!, d = Number(m[2]);
        selfTime.set(n, (selfTime.get(n) ?? 0) + d);
      }
    }
    const top = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log('  top (us self):', top.map(([n, d]) => `${n.slice(0, 55)}=${d}`).join('  '));
    await stats();
  }
}
await page.screenshot({ path: '_phone.png', timeout: 8000 }).catch(() => console.log('screenshot timed out (renderer busy)'));
await browser.close();
