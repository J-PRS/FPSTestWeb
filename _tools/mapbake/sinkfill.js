// sinkfill.js — soften unnaturally deep NARROW pits in a heightfield .bin.
// Detector: pit = blur(h, wideRadius) - h. A borehole's neighborhood is
// mostly its rim, so the blur sits far above the well floor → large pit.
// A wide canyon's blur includes its own floor → pit stays small. This also
// catches craters that touch the map border (priority-flood misses those
// because they "drain" on the torus).
//   bun _tools/mapbake/sinkfill.js <in.bin> <out.bin> [--maxDepth=30]
//                                  [--compress=0.2] [--radius=120]
const { writeFileSync, readFileSync } = await import('node:fs');

const args = process.argv.slice(2);
const inBin = args[0], outBin = args[1];
const opts = {};
for (const a of args.slice(2)) {
  const m = a.match(/^--([\w-]+)=?(.*)$/);
  if (m) { opts[m[1]] = m[2] === '' ? true : m[2]; }
}
if (!inBin || !outBin) { console.error('usage: sinkfill.js <in.bin> <out.bin> [--maxDepth=30] [--compress=0.2] [--radius=120]'); process.exit(1); }
const maxDepthM = Number(opts.maxDepth ?? 30);
const compress = Number(opts.compress ?? 0.2);
const radiusM = Number(opts.radius ?? 120);

const buf = readFileSync(inBin);
const N = buf.readUInt32LE(0);
if (buf.byteLength !== 8 + N * N) { console.error('bad bin'); process.exit(1); }
const spec = JSON.parse(readFileSync(inBin.replace(/\.bin$/, '.json'), 'utf8'));
const mPerByte = 125 * (spec.heightScale ?? 1) / 255;
const maxDepth = maxDepthM / mPerByte;
const texel = (spec.tileSize ?? 1500) / N;
const R = Math.max(2, Math.round(radiusM / texel));

const h = new Float32Array(N * N);
for (let i = 0; i < N * N; i += 1) { h[i] = buf[8 + i]; }

// Separable box blur, toroidal. Two passes: rows then columns.
const blur = new Float32Array(N * N);
const tmp = new Float32Array(N * N);
const w = 2 * R + 1;
for (let z = 0; z < N; z += 1) {
  let acc = 0;
  for (let x = -R; x <= R; x += 1) { acc += h[z * N + ((x + N) % N)]; }
  for (let x = 0; x < N; x += 1) {
    tmp[z * N + x] = acc / w;
    acc += h[z * N + ((x + R + 1) % N)] - h[z * N + ((x - R + N) % N)];
  }
}
for (let x = 0; x < N; x += 1) {
  let acc = 0;
  for (let z = -R; z <= R; z += 1) { acc += tmp[((z + N) % N) * N + x]; }
  for (let z = 0; z < N; z += 1) {
    blur[z * N + x] = acc / w;
    acc += tmp[((z + R + 1) % N) * N + x] - tmp[((z - R + N) % N) * N + x];
  }
}

// Squash only the cells whose local context stands far above them.
// Blend over a band at the threshold; compress the excess depth.
const band = maxDepth * 0.3;
const out = new Uint8Array(buf.length);
out.set(buf.subarray(0, 8));
let cells = 0, deepest = 0;
for (let i = 0; i < N * N; i += 1) {
  const pit = blur[i] - h[i];
  let v = h[i];
  if (pit > maxDepth - band) {
    cells += 1;
    deepest = Math.max(deepest, pit * mPerByte);
    const squashTo = blur[i] - Math.min(pit, maxDepth + (pit - maxDepth) * compress);
    const t = Math.min(1, Math.max(0, (pit - (maxDepth - band)) / (band * 2)));
    const blend = t * t * (3 - 2 * t);
    v = h[i] + (squashTo - h[i]) * blend;
  }
  out[8 + i] = Math.round(Math.max(0, Math.min(255, v)));
}
writeFileSync(outBin, out);
console.log(`sinkfill: ${cells} cells softened (context radius ${radiusM}m, >${maxDepthM}m local pits, compress ${compress}, deepest ${deepest.toFixed(0)}m)`);
