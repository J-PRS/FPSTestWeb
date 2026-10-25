/**
 * browser.ts — headless Chrome launcher for E2E specs.
 *
 * Works on a LOCKED desktop: puppeteer-core drives the system Chrome
 * --headless=new with SwiftShader WebGL. No X session, no focus.
 *
 * Exposes the game's dev `__test` hook (main.ts wires it when
 * import.meta.env.DEV — i.e. always under `npm run dev`).
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import type { Page, Browser } from 'puppeteer-core';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');

// CHROME_PATH wins; otherwise probe the usual install spots
// (Windows dev box first, then Linux CI runners).
const CHROME = process.env.CHROME_PATH
  ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p))
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** Pointer-lock stub — headless Chrome has none; the game gates input on
 *  document.pointerLockElement === canvas, so the stub must return the
 *  element requestPointerLock was called on (see headless-game-testing). */
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

export interface Client {
  page: Page;
  /** Read `window.__test` (subset) — undefined until main.ts init lands it. */
  test<T = Record<string, unknown>>(expr: string): Promise<T>;
  /** Poll a __test expression until it returns truthy (default 20s). */
  waitFor(expr: string, timeoutMs?: number): Promise<unknown>;
}

export interface LaunchOpts {
  /** JS evaluated before any page script — seed localStorage here (settings
   *  are read once at boot; a post-load write is too late). Specs that
   *  need deterministic quality use it to pin `fps-autoq` off. */
  preload?: string;
}

export async function launchClient(clientUrl: string, opts: LaunchOpts = {}): Promise<Client> {
  // E2E_HEADED=1 runs visible Chrome (unlocked PCs only — headed needs a
  // desktop session). Real GPU + real frame pacing, so game-time matches
  // wall time and the soak numbers are production-true.
  const headed = Boolean(process.env.E2E_HEADED);
  const browser: Browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !headed,
    // Headed on a FRESH profile does ~45s of first-run network work
    // (variations seed / component updater) that blocks every page fetch;
    // a persistent dir makes run 2+ warm. Headless keeps clean-profile
    // determinism.
    ...(headed || process.env.E2E_PROFILE ? { userDataDir: `${process.env.TEMP ?? 'C:/TEMP'}/e2e-chrome-profile` } : {}),
    // SwiftShader by default for determinism; E2E_GPU or headed uses real
    // hardware GL (SwiftShader raster costs skew every phase number).
    args: (process.env.E2E_GPU || headed)
      ? [
          `--use-angle=${process.env.E2E_ANGLE ?? 'default'}`,
          '--mute-audio', '--no-sandbox', '--start-maximized',
          // Headed Chrome background-throttles rAF/timers — the game
          // boots off rAF, so an occluded window can stall the whole
          // join path before the first frame.
          '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          // Fresh-profile Chrome WPAD-probes on the first connection —
          // loopback ws handshakes sat in CONNECTING for ~50s through it.
          '--no-proxy-server',
          // Fresh-profile first-run work (default-browser prompt, safety
          // check) defers network + asset loads ~40s on this box.
          '--no-first-run', '--no-default-browser-check',
          // Chrome's local-network-access gate (LNA/PNA successor):
          // page on localhost:PORT opening ws/fetch to 127.0.0.1:PORT
          // sat ~40s pending a permission check that never surfaces in
          // automation — the model load and connect released together.
          '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendHeaders,BlockInsecurePrivateNetworkRequests',
          // Every launch stalls ALL page fetch/ws ~30-45s on this box —
          // background pings (variations seed, safe-browsing, component
          // updater) to unreachable Google endpoints gate the socket
          // scheduler until they time out.
          '--disable-background-networking', '--disable-component-update',
          '--safebrowsing-disable-auto-update', '--disable-sync',
          '--metrics-recording-only', '--disable-breakpad',
          // Lifts the post-Spectre fuzzing on WebGL2 timer queries —
          // ?gpuperf pass profiling reads exact GPU ms, not ~1ms steps.
          '--enable-webgl-developer-extensions',
        ]
      : [
          '--use-gl=angle', '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox',
        ],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(POINTER_LOCK_STUB);
  if (opts.preload) {await page.evaluateOnNewDocument(opts.preload);}
  // Vite's HMR client rejects with "WebSocket closed without opened" when
  // the page loads faster than the dev-server socket — dev-server noise,
  // not game code. Keep real page errors loud.
  page.on('pageerror', (e) => {
    const m = e instanceof Error ? e.message : String(e);
    if (!m.includes('WebSocket closed without opened')) console.error('[pageerror]', m);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) console.error(`[http ${r.status()}]`, r.url().slice(0, 200));
  });
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warn') return;
    const t = m.text();
    if (t.includes('WebSocket closed without opened') || t.includes('THREE.WebGLRenderer: Context Lost')) return;
    console.error(`[console.${m.type()}]`, t.slice(0, 600));
  });
  await page.goto(clientUrl, { waitUntil: 'domcontentloaded' });
  // Headed windows open behind whatever's on screen; an occluded page
  // gets its worker threads + ws lanes throttled to a halt (blob-worker
  // probe: silent >8s). Foreground it or the whole net stack starves.
  if (headed) {await page.bringToFront();}

  const test = <T = Record<string, unknown>>(expr: string): Promise<T> =>
    page.evaluate(`(() => { const t = window.__test; return ${expr}; })()`) as Promise<T>;

  const waitFor = (expr: string, timeoutMs = 20000): Promise<unknown> =>
    page.waitForFunction(`(() => { const t = window.__test; return t && (${expr}); })()`, { timeout: timeoutMs });

  return { page, test, waitFor };
}

export async function closeClient(c: Client): Promise<void> {
  await c.page.browser().close();
}
