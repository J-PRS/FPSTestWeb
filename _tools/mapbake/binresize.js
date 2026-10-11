// Heightfield .bin resample — box-average downsample to a smaller grid.
// Usage: node binresize.js <in.bin> <out.bin> <size>
// Same wire format as png2bin (8-byte LE w,h + uint8 grid). Averaging
// whole texel blocks — not nearest — so quantized terracing smooths a
// little instead of picking lucky samples. <size> must divide the
// source edge evenly (2048 -> 512, not 2048 -> 500).

const { readFileSync, writeFileSync } = await import('node:fs');

const [inBin, outBin, sizeArg] = process.argv.slice(2);
const M = Number(sizeArg);
if (!inBin || !outBin || !Number.isInteger(M) || M < 2) {
  console.error('usage: binresize.js <in.bin> <out.bin> <size>');
  process.exit(1);
}

const buf = readFileSync(inBin);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const N = dv.getUint32(0, true);
if (dv.getUint32(4, true) !== N || buf.byteLength !== 8 + N * N) {
  console.error(`bad bin: header says ${N}x${dv.getUint32(4, true)}, file is ${buf.byteLength}B`);
  process.exit(1);
}
if (N % M !== 0) {
  console.error(`cannot resample ${N} -> ${M}: does not divide evenly`);
  process.exit(1);
}
const k = N / M;
const src = buf.subarray(8);
const out = Buffer.alloc(8 + M * M);
out.writeUInt32LE(M, 0);
out.writeUInt32LE(M, 4);
for (let z = 0; z < M; z++) {
  for (let x = 0; x < M; x++) {
    let s = 0;
    for (let dz = 0; dz < k; dz++) {
      for (let dx = 0; dx < k; dx++) {
        s += src[(z * k + dz) * N + x * k + dx];
      }
    }
    out[8 + z * M + x] = Math.round(s / (k * k));
  }
}
writeFileSync(outBin, out);
console.log(`${inBin} ${N}x${N} -> ${outBin} ${M}x${M} (${8 + M * M}B)`);
