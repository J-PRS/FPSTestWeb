// _gibshot.ts — headless shot of the gunlab 'classes' lineup mid-pulverize.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'bun';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
const CHROME = process.env.CHROME_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));
const PORT = Number(process.env.GUNLAB_PORT ?? 5459);
const vite = process.env.GUNLAB_PORT ? null
  : spawn([process.platform === 'win32' ? 'npx.cmd' : 'npx', 'vite', '--port', String(PORT), '--strictPort'],
    { cwd: 'client', stdout: 'ignore', stderr: 'ignore' });
try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) {break;} } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  page.on('pageerror', (e) => console.error('[pageerror]', e instanceof Error ? e.message : e));
  await page.goto(`http://localhost:${PORT}/gunlab.html`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForFunction('document.querySelectorAll("#rail button").length > 0', { timeout: 30000 });
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === 'classes'));
    if (sel) { sel.value = 'classes'; sel.dispatchEvent(new Event('change')); }
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll<HTMLElement>('#rail button')].find((b) => b.textContent?.trim() === 'classes');
    btn?.click();
  });
  // model loads + clip settle on SwiftShader — GLBs take 60-90s+
  await new Promise((r) => setTimeout(r, 90000));
  await page.screenshot({ path: resolve(import.meta.dir, '../../screenshots/gib_pre.png') });
  await page.evaluate(() => {
    const gl = (window as any).__gl;
    gl.orbit.target.set(0.3, 1.4, 0);
    gl.camera.position.set(0.3, 2.4, 8.5);
    gl.orbit.update();
  });
  await new Promise((r) => setTimeout(r, 800));
  // freeze the mixer: SwiftShader sim-time is slow, so click pulverize
  // and shoot several frames of the burst
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'pulverize');
    btn?.click();
  });
  for (const [i, delay] of [[0, 500], [1, 600], [2, 900]] as const) {
    await new Promise((r) => setTimeout(r, delay));
    const out = resolve(import.meta.dir, `../../screenshots/gib_${i}.png`);
    await page.screenshot({ path: out });
    console.log('wrote', out);
  }
  await browser.close();
} finally { vite?.kill(); }
