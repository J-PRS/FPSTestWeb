// PNG heightmap → server heightfield .bin (8-byte LE w,h + uint8 grid).
// Usage: node png2bin.js <in.png> <out.bin>
// The PNG's R channel becomes the raw field byte — same convention the
// client's loadHeightmap and the server's parseHeightmap share, so a
// bin baked from the boot PNG is byte-identical to what clients had.
// Runs inside headless Chrome for the canvas decode; puppeteer-core is
// already vendored in _tools/demorender.

const { createRequire } = await import('node:module');
const { readFileSync, writeFileSync } = await import('node:fs');
const require = createRequire(import.meta.url);
const puppeteer = require('../demorender/node_modules/puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const [inPng, outBin] = process.argv.slice(2);
if (!inPng || !outBin) { console.error('usage: png2bin.js <in.png> <out.bin>'); process.exit(1); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
try {
  const page = await browser.newPage();
  const b64 = readFileSync(inPng).toString('base64');
  const { w, h, data } = await page.evaluate(async (b64png) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64png; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const r = new Uint8Array(c.width * c.height);
    for (let i = 0; i < r.length; i++) r[i] = px[i * 4];
    return { w: c.width, h: c.height, data: Array.from(r) };
  }, b64);
  const out = Buffer.alloc(8 + w * h);
  out.writeUInt32LE(w, 0); out.writeUInt32LE(h, 4);
  Buffer.from(data).copy(out, 8);
  writeFileSync(outBin, out);
  console.log(`${inPng} → ${outBin} (${w}x${h})`);
} finally {
  await browser.close();
}
