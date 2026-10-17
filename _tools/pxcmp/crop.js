// Crop+zoom the plume region of two shots (before/after) into one PNG so a
// human can see whether the change landed.  node crop.js a.png b.png out.png [cx] [cy] [w] [h]
const { PNG } = require('pngjs');
const fs = require('fs');

const [fa, fb, out, cx = '400', cy = '300', w = '220', h = '190'] = process.argv.slice(2);
const CX = +cx, CY = +cy, W = +w, H = +h, Z = 3;

function crop(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const out = new PNG({ width: W * Z, height: H * Z });
  const x0 = Math.round(CX - W / 2), y0 = Math.round(CY - H / 2);
  for (let y = 0; y < H * Z; y++) for (let x = 0; x < W * Z; x++) {
    const sx = x0 + Math.floor(x / Z), sy = y0 + Math.floor(y / Z);
    const di = (y * out.width + x) * 4;
    if (sx < 0 || sy < 0 || sx >= png.width || sy >= png.height) { out.data[di + 3] = 0; continue; }
    const si = (sy * png.width + sx) * 4;
    out.data[di] = png.data[si]; out.data[di + 1] = png.data[si + 1];
    out.data[di + 2] = png.data[si + 2]; out.data[di + 3] = 255;
  }
  return out;
}

// mean luminance + std of the window on each source, for a numeric read
function stats(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const x0 = Math.round(CX - W / 2), y0 = Math.round(CY - H / 2);
  let s = 0, s2 = 0, n = 0;
  for (let y = y0; y < y0 + H; y++) for (let x = x0; x < x0 + W; x++) {
    const i = (y * png.width + x) * 4;
    const l = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
    s += l; s2 += l * l; n++;
  }
  const m = s / n;
  return { mean: +m.toFixed(1), std: +Math.sqrt(s2 / n - m * m).toFixed(1) };
}

const a = crop(fa), b = crop(fb);
// stack horizontally: A | B
const both = new PNG({ width: a.width * 2 + 8, height: a.height });
for (let y = 0; y < a.height; y++) {
  for (let x = 0; x < a.width; x++) {
    const di = (y * both.width + x) * 4, si = (y * a.width + x) * 4;
    both.data[di] = a.data[si]; both.data[di + 1] = a.data[si + 1]; both.data[di + 2] = a.data[si + 2]; both.data[di + 3] = 255;
  }
  for (let x = 0; x < b.width; x++) {
    const di = (y * both.width + a.width + 8 + x) * 4, si = (y * b.width + x) * 4;
    both.data[di] = b.data[si]; both.data[di + 1] = b.data[si + 1]; both.data[di + 2] = b.data[si + 2]; both.data[di + 3] = 255;
  }
}
fs.writeFileSync(out, PNG.sync.write(both));
console.log('A(luma)', JSON.stringify(stats(fa)), 'B(luma)', JSON.stringify(stats(fb)), '->', out);
