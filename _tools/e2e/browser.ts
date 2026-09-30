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

export async function launchClient(clientUrl: string): Promise<Client> {
  const browser: Browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox',
    ],
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(POINTER_LOCK_STUB);
  // Vite's HMR client rejects with "WebSocket closed without opened" when
  // the page loads faster than the dev-server socket — dev-server noise,
  // not game code. Keep real page errors loud.
  page.on('pageerror', (e) => {
    if (!e.message.includes('WebSocket closed without opened')) console.error('[pageerror]', e.message);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const t = m.text();
    if (t.includes('WebSocket closed without opened') || t.includes('THREE.WebGLRenderer: Context Lost')) return;
    console.error(`[console.${m.type()}]`, t.slice(0, 600));
  });
  await page.goto(clientUrl, { waitUntil: 'domcontentloaded' });

  const test = <T = Record<string, unknown>>(expr: string): Promise<T> =>
    page.evaluate(`(() => { const t = window.__test; return ${expr}; })()`) as Promise<T>;

  const waitFor = (expr: string, timeoutMs = 20000): Promise<unknown> =>
    page.waitForFunction(`(() => { const t = window.__test; return t && (${expr}); })()`, { timeout: timeoutMs });

  return { page, test, waitFor };
}

export async function closeClient(c: Client): Promise<void> {
  await c.page.browser().close();
}
