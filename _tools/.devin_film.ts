// Temp probe: record the flagrun TAS ghost flight to a video file.
// Usage: bun .devin_film.ts [url] [seconds] [out.webm]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const url = process.argv[2] ?? 'http://localhost:5173/?mode=flagrun&tas=0->1&film=1';
const secs = Number(process.argv[3] ?? 26);
const out = process.argv[4] ?? 'C:/TEMP/_WEB/FPSWebTest/tas_film.webm';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: false,
  args: ['--mute-audio', '--no-sandbox', '--window-size=1620,980',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', (e) => console.error('[pageerror]', String(e?.message ?? e)));
await page.evaluateOnNewDocument(`
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
`);

console.log('loading', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction('!!document.querySelector("canvas")', { timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
// pointer-lock entry is click-gated — synthesize a click on the canvas.
await page.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  c?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await new Promise(r => setTimeout(r, 5000)); // spawn + ghost fetch

const rec = await page.evaluate(async (s) => {
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
  const stream = (canvas as HTMLCanvasElement).captureStream(60);
  const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m))!;
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  mr.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise<void>(r => { mr.onstop = () => r(); });
  mr.start(250);
  await new Promise(r => setTimeout(r, s * 1000));
  mr.stop(); await done;
  const blob = new Blob(chunks, { type: mime });
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), mime };
}, secs);

const ext = rec.mime.includes('mp4') ? '.mp4' : '.webm';
const file = out.replace(/\.(webm|mp4)$/, '') + ext;
writeFileSync(file, Buffer.from(rec.b64, 'base64'));
console.log('wrote', file, rec.mime);
await browser.close();
