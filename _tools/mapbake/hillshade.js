// hillshade.js — render a heightfield .bin as a hillshaded relief PNG, so
// terrain SHAPE (bowls, ridges, runs) is judgeable at a glance.
//   bun _tools/mapbake/hillshade.js <bin> [<out.png>]
// Reads the sibling <name>.json for heightScale/tileSize. Output defaults to
// <bin>.relief.png.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) { c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } t[n] = c >>> 0; }
  return (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i += 1) { c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); } return (c ^ 0xFFFFFFFF) >>> 0; };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
function writePng(file, w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// Hypsometric ramp (deep -> high) as [r,g,b] stops.
const STOPS = [[20, 40, 70], [40, 90, 80], [90, 130, 70], [170, 160, 90], [190, 150, 120], [240, 240, 245]];
const ramp = (t) => {
  const x = Math.min(0.999, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.floor(x), f = x - i, a = STOPS[i], b = STOPS[i + 1] ?? STOPS[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
};

const bin = process.argv[2];
if (!bin) { console.error('usage: hillshade.js <bin> [out.png]'); process.exit(1); }
const out = process.argv[3] ?? bin.replace(/\.bin$/, '.relief.png');
const buf = fs.readFileSync(bin);
const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
if (w !== h || buf.byteLength !== 8 + w * h) { console.error('bad header'); process.exit(1); }
const data = buf.subarray(8);
let spec = {};
try { spec = JSON.parse(fs.readFileSync(bin.replace(/\.bin$/, '.json'), 'utf8')); } catch { /* no spec */ }
const hs = spec.heightScale ?? 1;
const tile = spec.tileSize ?? 1500;
const mPerByte = 125 * hs / 255;
const texel = tile / w;

// Light from the NW, ~45 deg up.
const az = (315 * Math.PI) / 180, al = (45 * Math.PI) / 180;
const Lx = Math.cos(az) * Math.cos(al), Ly = Math.sin(al), Lz = Math.sin(az) * Math.cos(al);

const rgb = Buffer.alloc(w * h * 3);
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    const hC = data[i] * mPerByte;
    const hL = data[y * w + ((x - 1 + w) % w)] * mPerByte;
    const hR = data[y * w + ((x + 1) % w)] * mPerByte;
    const hU = data[((y - 1 + h) % h) * w + x] * mPerByte;
    const hD = data[((y + 1) % h) * w + x] * mPerByte;
    const dzdx = (hR - hL) / (2 * texel);
    const dzdy = (hD - hU) / (2 * texel);
    // Normal of the surface z=f(x,y): n = (-dzdx, 1, -dzdy) normalized.
    const nx = -dzdx, ny = 1, nz = -dzdy;
    const il = 1 / Math.hypot(nx, ny, nz);
    const shade = Math.max(0.08, (nx * Lx + ny * Ly + nz * Lz) * il);
    // Gentle ambient so flat ground doesn't read black.
    const s = Math.min(1.5, shade * 1.25 + 0.12);
    // elevation ramp from the byte value directly
    const el = data[i] / 255;
    const c = ramp(el);
    rgb[i * 3] = Math.min(255, c[0] * s);
    rgb[i * 3 + 1] = Math.min(255, c[1] * s);
    rgb[i * 3 + 2] = Math.min(255, c[2] * s);
  }
}
writePng(out, w, h, rgb);
let mn = 255, mx = 0;
for (const v of data) { if (v < mn) mn = v; if (v > mx) mx = v; }
console.log(`${out}  ${w}x${w}  relief ${((mx - mn) * mPerByte).toFixed(0)}m`);
