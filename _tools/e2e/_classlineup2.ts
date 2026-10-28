// _classlineup2.ts — same lineup shot but against the RUNNING dev server
// on :5400 (not a spawned vite) + optional ?glbnw=1 to A/B the worker path.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
const CHROME = process.env.CHROME_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p));
const PORT = 5400;
const suffix = process.argv.includes('--glbnw') ? '&glbnw=1' : '';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 800 });
page.on('pageerror', (e) => console.error('[pageerror]', e instanceof Error ? e.message : e));
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning' || m.text().includes('glb') || m.text().includes('fail')) {console.log('[page]', m.text().slice(0, 240));} });
await page.goto(`http://localhost:${PORT}/gunlab.html?x=1${suffix}`, { waitUntil: 'networkidle0', timeout: 30000 });
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
await new Promise((r) => setTimeout(r, 15000));
await page.evaluate(() => {
  const gl = (window as any).__gl;
  gl.orbit.target.set(0.3, 1.4, 0);
  gl.camera.position.set(0.3, 2.4, 8.5);
  gl.orbit.update();
});
await new Promise((r) => setTimeout(r, 1200));
const probe = await page.evaluate(() => {
  const gl = (window as any).__gl;
  let skinned = 0, meshes = 0;
  gl?.scene?.traverse?.((o: any) => { if (o.isSkinnedMesh) skinned++; else if (o.isMesh) meshes++; });
  return { skinned, meshes, sceneChildren: gl?.scene?.children?.length };
});
console.log('probe', JSON.stringify(probe));
const out = resolve(import.meta.dir, `../../screenshots/classes_lineup${suffix ? '_main' : '_worker'}.png`);
await page.screenshot({ path: out });
console.log('wrote', out);
await browser.close();
