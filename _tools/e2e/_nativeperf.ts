// nativeperf — perf.ts-style sampling INSIDE the electrobun WebView2 window.
// Points CLIENT_URL at a spawned e2e stack, exposes WebView2's CDP port via
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, attaches puppeteer, samples rAF
// deltas + __perf phases + __gpuPass GPU ms — same metrics as perf.ts.
//   bun _tools/e2e/_nativeperf.ts [map] [--secs 15] [--uncap]
import puppeteer from 'puppeteer-core';
import { upStack } from './env.ts';

const MAP = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'lagoon';
const arg = (n: string, d = ''): string => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? (process.argv[i + 1] ?? d) : d; };
const SECS = Number(arg('secs', '15'));
const UNCAP = process.argv.includes('--uncap');
const LAUNCHER = 'native/build/dev-win-x64/hello-world-dev/bin/launcher.exe';
const CDP = 9223;

const stack = await upStack();
let launcher: ReturnType<typeof Bun.spawn> | null = null;
let browser: Awaited<ReturnType<typeof puppeteer.connect>> | null = null;
try {
  const url = stack.clientUrl(`&room=nativeperf&map=${MAP}&bots=8&gpuperf=1&debug=1&net=ws`);
  const wv2args = ['--remote-debugging-port=9223', '--enable-webgl-developer-extensions'];
  if (UNCAP) {wv2args.push('--disable-gpu-vsync', '--disable-frame-rate-limit');}
  console.log('launching native window ->', url);
  launcher = Bun.spawn([LAUNCHER], {
    env: { ...process.env, CLIENT_URL: url, FULLSCREEN: '0',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: wv2args.join(' ') },
    stdout: 'inherit', stderr: 'inherit',
  });
  // Wait for the WebView2 CDP endpoint.
  let pages: { url?: string; webSocketDebuggerUrl?: string }[] = [];
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
      pages = await r.json() as typeof pages;
      if (pages.some((p) => p.url?.includes('room='))) {break;}
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const target = pages.find((p) => p.url?.includes('room='));
  if (!target) {console.log('FAIL: no game page on CDP'); process.exit(1);}
  console.log('cdp page:', target.url?.slice(0, 90));
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
  const page = await browser.pages().then((ps) => ps.find((p) => p.url().includes('room=')));
  if (!page) {console.log('FAIL: puppeteer sees no game page'); process.exit(1);}
  await page.waitForFunction('window.__test && window.__test.networkManager && window.__test.networkManager.isConnected()', { timeout: 90000 });
  await page.evaluate(`(() => {
    window.__frames = [];
    let last = performance.now();
    const loop = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  })()`);
  await new Promise((r) => setTimeout(r, 4000));
  await page.evaluate('window.__frames = []');
  await new Promise((r) => setTimeout(r, SECS * 1000));
  const deltas = (await page.evaluate('window.__frames') as number[]).sort((a, b) => a - b);
  const n = deltas.length, q = (p: number) => deltas[Math.floor(n * p)]!;
  const fps = +(1000 / (deltas.reduce((s, d) => s + d, 0) / n)).toFixed(1);
  console.log(`NATIVE ${MAP}${UNCAP ? ' uncap' : ''} frames=${n} fps=${fps} median=${q(0.5).toFixed(2)}ms p95=${q(0.95).toFixed(2)}ms p99=${q(0.99).toFixed(2)}ms worst=${deltas[n - 1]!.toFixed(1)}ms`);
  const ph = await page.evaluate('window.__perf ? window.__perf() : null').catch(() => null);
  if (ph) {
    console.log(`  phases frame=${(ph.frame ?? 0).toFixed(1)}ms | ` +
      Object.entries(ph).filter(([k, v]) => k !== 'frame' && typeof v === 'number' && v >= 0.5).map(([k, v]) => `${k}=${(v as number).toFixed(1)}`).join(' '));
  }
  const gp = await page.evaluate('window.__gpuPass ? window.__gpuPass() : null').catch(() => null);
  for (const r of (gp as { pass: string; avgMs: number; maxMs: number; n: number }[] | null) ?? []) {
    console.log(`  gpu:pass ${r.pass} avg=${r.avgMs.toFixed(2)}ms max=${r.maxMs.toFixed(2)}ms n=${r.n}`);
  }
} finally {
  try { await browser?.disconnect(); } catch { /* already gone */ }
  try { launcher?.kill(); } catch { /* already gone */ }
  await stack.down();
}
