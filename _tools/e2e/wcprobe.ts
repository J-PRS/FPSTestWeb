// Probe: does Chrome's WebCodecs VideoEncoder land on hardware (NVENC)?
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--use-angle=d3d11', '--no-sandbox', '--enable-features=SharedArrayBuffer',
    '--enable-unsafe-webgpu', '--force-color-profile=srgb', '--disable-frame-rate-limit'],
});
const page = await browser.newPage();
await page.goto('http://localhost:5400/', { waitUntil: 'domcontentloaded', timeout: 30000 });
const out = await page.evaluate(async () => {
  const cfg = {
    codec: 'avc1.640032', width: 1920, height: 1080, bitrate: 12_000_000, framerate: 60,
    // @ts-expect-error ahead of TS DOM lib
    hardwarePreference: 'prefer-hardware', latencyMode: 'realtime',
  };
  const sup = await VideoEncoder.isConfigSupported(cfg as VideoEncoderConfig);
  // Encode one real frame to confirm the encoder actually opens.
  let opened = false; let err = '';
  try {
    const enc = new VideoEncoder({ output: () => {}, error: (e) => { err = String(e); } });
    enc.configure(cfg as VideoEncoderConfig);
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    enc.encode(new VideoFrame(c, { timestamp: 0 }), { keyFrame: true });
    await enc.flush();
    opened = true;
    enc.close();
  } catch (e) { err = String(e); }
  return { supported: sup?.supported, opened, err };
});
console.log(JSON.stringify(out));
await browser.close();
