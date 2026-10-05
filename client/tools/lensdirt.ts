// Regenerates public/assets/LensDirt/LensDirt03_1k.avif — the lens-dirt
// multiplier mask renderer.ts feeds the post chain. Procedural on purpose:
// the upstream LensDirt texture was never committable (license), so this
// bakes a deterministic look-alike (seeded) instead of shipping a rip.
//   bun tools/lensdirt.ts
import sharp from 'sharp';
import { mkdirSync, statSync } from 'node:fs';

const N = 1024;
let s = 0x9e3779b9;
const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const buf = new Float32Array(N * N * 3);

// ~90 soft elongated smudges — gaussian blobs stretched along a random axis
for (let i = 0; i < 90; i++) {
  const cx = rnd() * N, cy = rnd() * N, ang = rnd() * Math.PI;
  const rx = 40 + rnd() * 180, ry = 8 + rnd() * 30, a = 0.05 + rnd() * 0.35;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const R = Math.ceil(Math.max(rx, ry) * 3);
  for (let y = Math.max(0, (cy - R) | 0); y < Math.min(N, cy + R); y++)
    for (let x = Math.max(0, (cx - R) | 0); x < Math.min(N, cx + R); x++) {
      const dx = x - cx, dy = y - cy;
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      const g = Math.exp(-(u * u) / (2 * rx * rx) - (v * v) / (2 * ry * ry)) * a;
      const k = (y * N + x) * 3;
      buf[k]! += g; buf[k + 1]! += g; buf[k + 2]! += g;
    }
}

// dust speckle — sparse bright dots with soft falloff
for (let i = 0; i < 300; i++) {
  const cx = (rnd() * N) | 0, cy = (rnd() * N) | 0, r = 1 + rnd() * 3, a = 0.1 + rnd() * 0.5;
  for (let y = Math.max(0, cy - 6); y < Math.min(N, cy + 6); y++)
    for (let x = Math.max(0, cx - 6); x < Math.min(N, cx + 6); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const g = Math.exp(-d2 / (2 * r * r)) * a;
      const k = (y * N + x) * 3;
      buf[k]! += g; buf[k + 1]! += g; buf[k + 2]! += g;
    }
}

const px = Buffer.alloc(N * N * 3);
for (let i = 0; i < px.length; i++) px[i] = Math.min(255, buf[i]! * 255);
mkdirSync('public/assets/LensDirt', { recursive: true });
await sharp(px, { raw: { width: N, height: N, channels: 3 } })
  .avif({ quality: 60 })
  .toFile('public/assets/LensDirt/LensDirt03_1k.avif');
console.log('wrote', statSync('public/assets/LensDirt/LensDirt03_1k.avif').size, 'bytes');
