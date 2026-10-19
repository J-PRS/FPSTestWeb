// _outlineshot.ts — gunlab classes lineup with mark=outline, side=enemy.
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
  page.on('console', (m) => { if (m.type() === 'error') {console.error('[console]', m.text().slice(0, 400));} });
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
  // mark=outline + side=enemy via the rail selects
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => {
    const sels = [...document.querySelectorAll('select')];
    const mark = sels.find((s) => [...s.options].some((o) => o.value === 'outline'));
    if (mark) { mark.value = 'outline'; mark.dispatchEvent(new Event('change')); }
    const side = sels.find((s) => [...s.options].some((o) => o.value === 'ally'));
    if (side) { side.value = 'enemy'; side.dispatchEvent(new Event('change')); }
  });
  await new Promise((r) => setTimeout(r, 90000));
  await page.evaluate(() => {
    // FPS-mode camera stomps orbit writes — switch to inspect first.
    const btn = [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.includes('inspect'));
    btn?.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => {
    const gl = (window as any).__gl;
    gl.orbit.target.set(0, 1.1, 0);
    gl.camera.position.set(0, 1.6, 9);
    gl.orbit.update();
  });
  await new Promise((r) => setTimeout(r, 1500));
  const out = resolve(import.meta.dir, '../../screenshots/outline.png');
  await page.screenshot({ path: out });
  console.log('wrote', out);
  await browser.close();
} finally { vite?.kill(); }
