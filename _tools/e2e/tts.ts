/**
 * tts.ts - Time To Shoot: cold-boot benchmark from URL entry to the first
 * fired shot. Headless Chrome, fresh profile, disk cache disabled.
 *
 *   bun _tools/e2e/tts.ts [url] [--runs N] [--headed]
 *
 * Debug mode (default URL below uses ?debug=1): uses window.__test.player.lastFireAt.
 * Non-debug mode (pass ?tts=1 instead of ?debug=1): uses a one-shot
 * window.__ttsShot marker added to spawnProjectile; no debug overlays.
 *
 * Defaults to http://localhost:5500/?tts=1 (no wireframes).
 */
import { createRequire } from 'node:module';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');

const CHROME = process.env.CHROME_PATH
  ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p))
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};

const url = process.argv[2] ?? 'http://localhost:5500/?tts=1';
const RUNS = +arg('runs', '5');
const headed = process.argv.includes('--headed') || Boolean(process.env.E2E_HEADED);
const debugMode = /[?&]debug=1\b/.test(url) || /[?&]debug=true\b/.test(url);
const gpu = Boolean(process.env.E2E_GPU);

const POINTER_LOCK_STUB = `
  window.__lockedEl = null;
  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    get() { return window.__lockedEl; }, configurable: true });
  Element.prototype.requestPointerLock = function () {
    window.__lockedEl = this;
    queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')));
    return Promise.resolve(); };
  document.exitPointerLock = function () {
    window.__lockedEl = null;
    queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange'))); };
`;

const BASE_ARGS = headed
  ? ['--mute-audio', '--no-sandbox', '--disable-background-timer-throttling',
     '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
     '--no-proxy-server', '--no-first-run', '--no-default-browser-check',
     '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendHeaders,BlockInsecurePrivateNetworkRequests',
     '--disable-background-networking', '--disable-component-update',
     '--safebrowsing-disable-auto-update', '--disable-sync']
  : gpu
    ? [
        `--use-angle=${process.env.E2E_ANGLE ?? 'default'}`,
        '--mute-audio', '--no-sandbox', '--start-maximized',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--no-proxy-server', '--no-first-run', '--no-default-browser-check',
        '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendHeaders,BlockInsecurePrivateNetworkRequests',
        '--disable-background-networking', '--disable-component-update',
        '--safebrowsing-disable-auto-update', '--disable-sync',
        '--metrics-recording-only', '--disable-breakpad',
        '--enable-webgl-developer-extensions',
      ]
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
       '--mute-audio', '--no-sandbox'];

const CACHE_ARGS = [
  '--disk-cache-size=0', '--media-cache-size=0',
  '--disable-gpu-shader-disk-cache', '--disable-application-cache',
];

for (let run = 0; run < RUNS; run += 1) {
  const userDataDir = join(process.env.TEMP ?? 'C:/TEMP', `e2e-tts-${run}-${Date.now()}`);
  mkdirSync(userDataDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !headed,
    userDataDir,
    args: [...BASE_ARGS, ...CACHE_ARGS, `--user-data-dir=${userDataDir}`],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(POINTER_LOCK_STUB);
  await page.setCacheEnabled(false);

  // Non-debug: track first inbound WS frame after canvas appears.
  let firstFrameAt = 0;
  let canvasSeen = false;
  if (!debugMode) {
    page.on('websocket', (ws: any) => {
      ws.on('framereceived', () => {
        if (canvasSeen && !firstFrameAt) firstFrameAt = performance.now();
      });
    });
  }

  const runStart = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  page.on('console', (m: any) => {
    const t = m.text();
    if (t.includes('boot-hitch') || t.includes('boot-frame')) console.log(`[page ${m.type()}] ${t}`);
  });

  let readyMs = -1;
  try {
    if (debugMode) {
      await page.waitForFunction(
        '(() => { const t = window.__test; return !!(t && t.player && typeof t.player.lastFireAt === "number"); })()',
        { timeout: 60000 },
      );
      readyMs = await page.evaluate('performance.now()') as number;
    } else {
      await page.waitForSelector('canvas', { timeout: 60000 });
      readyMs = await page.evaluate('performance.now()') as number;
      canvasSeen = true;
    }
  } catch (e) {
    const state = await page.evaluate('({ hasTest: !!window.__test, tts: (window as any).__ttsShot, ready: document.readyState, err: String(window.__bootErr ?? "") })').catch(() => ({}));
    console.log(`run ${run}: READY TIMEOUT page state=${JSON.stringify(state)}`);
    await browser.close();
    rmSync(userDataDir, { recursive: true, force: true });
    continue;
  }

  let shotMs = -1;
  let clickAt = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (c) { c.focus(); (c as any).requestPointerLock?.(); }
    return performance.now();
  });
  await new Promise((r) => setTimeout(r, 50));
  const box = await page.$eval('canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  if (debugMode) {
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.click(box.x, box.y);
      await new Promise((r) => setTimeout(r, 200));
    }
  } else {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      clickAt = await page.evaluate('performance.now()') as number;
      await page.mouse.click(box.x, box.y);
      await new Promise((r) => setTimeout(r, 300));
      const mark = await page.evaluate('window.__ttsShot');
      if (typeof mark === 'number') { shotMs = mark; break; }
    }
  }

  try {
    if (debugMode) {
      await page.waitForFunction(
        '(() => { const t = window.__test; return !!(t && t.player && t.player.lastFireAt > 0); })()',
        { timeout: 10000 },
      );
      shotMs = await page.evaluate('window.__test.player.lastFireAt') as number;
    } else {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const m = await page.evaluate('window.__ttsShot');
        if (typeof m === 'number') { shotMs = m; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (typeof shotMs !== 'number') throw new Error('no shot mark');
    }
  } catch (e) {
    console.log(`run ${run}: SHOT TIMEOUT (ready=${Math.round(readyMs)}ms click=${Math.round(clickAt)}ms)`);
    await browser.close();
    rmSync(userDataDir, { recursive: true, force: true });
    continue;
  }

  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return n ? { ttfb: Math.round(n.responseStart), dom: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), transferSize: n.transferSize } : null;
  });

  const dts = await page.evaluate((shotT: number) => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceResourceTiming | undefined;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const before = res.filter((r) => r.startTime < shotT);
    const total = (nav?.transferSize || 0) + before.reduce((s, r) => s + (r.transferSize || 0), 0);
    const byExt: Record<string, number> = {};
    for (const r of before) {
      const url = r.name.split('?')[0];
      const ext = url.slice(url.lastIndexOf('.') + 1).toLowerCase() || 'other';
      byExt[ext] = (byExt[ext] || 0) + (r.transferSize || 0);
    }
    if (nav?.transferSize) byExt['document'] = (byExt['document'] || 0) + nav.transferSize;
    const top = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { total, count: before.length + (nav ? 1 : 0), top };
  }, shotMs);

  const marks = await page.evaluate(() => performance.getEntriesByType('mark').map((m: any) => ({ name: m.name, t: Math.round(m.startTime) })).sort((a: any, b: any) => a.t - b.t));

  console.log(
    `run ${run}: TTS=${Math.round(shotMs)}ms ready=${Math.round(readyMs)}ms click=${Math.round(clickAt)}ms ` +
    `inputToShot=${Math.round(shotMs - clickAt)}ms wall=${Date.now() - runStart}ms nav=${JSON.stringify(nav)}`,
  );
  console.log(`run ${run}: marks=${JSON.stringify(marks)}`);
  console.log(`run ${run}: DTS=${(dts.total / 1024).toFixed(1)} KB (${dts.count} requests) top=${JSON.stringify(dts.top)}`);

  await browser.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
