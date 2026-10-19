// _classlineup.ts — headless shot of the gunlab 'classes' lineup.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'bun';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
const CHROME = process.env.CHROME_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));
const PORT = 5458;

const vite = spawn([process.platform === 'win32' ? 'npx.cmd' : 'npx', 'vite', '--port', String(PORT), '--strictPort'],
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
  // model loads + clip settle on SwiftShader — give it room
  await new Promise((r) => setTimeout(r, 15000));
  await page.evaluate(() => {
    // Bodies stand at x -1.9 / 0 / 2.4, labels to ~3.2m — frame center
    // ~x 0.3, pull back far enough that the full trio + labels fit a
    // 55° fov (half-width needed ≈ 3.4m → dist ≈ 6.6 + margin).
    const gl = (window as any).__gl;
    gl.orbit.target.set(0.3, 1.4, 0);
    gl.camera.position.set(0.3, 2.4, 8.5);
    gl.orbit.update();
  });
  await new Promise((r) => setTimeout(r, 1200));
  const out = resolve(import.meta.dir, '../../screenshots/classes_lineup.png');
  await page.screenshot({ path: out });
  console.log('wrote', out);
  await browser.close();
} finally { vite.kill(); }
