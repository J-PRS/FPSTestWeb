// Verifies makeNoiseTexture's math — same code copied inline.
const _noiseHash = (x: number, y: number): number => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
};
const _smooth = (t: number) => t * t * (3 - 2 * t);
const vnoise = (x: number, y: number, period: number): number => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = _smooth(x - xi), yf = _smooth(y - yi);
  const w = (v: number) => ((v % period) + period) % period;
  const a = _noiseHash(w(xi), w(yi)), b = _noiseHash(w(xi + 1), w(yi));
  const c = _noiseHash(w(xi), w(yi + 1)), d = _noiseHash(w(xi + 1), w(yi + 1));
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
};
const fbm = (u: number, v: number, basePeriod: number, octaves: number): number => {
  let sum = 0, amp = 0.5, per = basePeriod, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(u * per, v * per, per) * amp;
    norm += amp;
    amp *= 0.5;
    per *= 2;
  }
  return sum / norm;
};

let mn = 9, mx = -9, sum = 0, n = 0, hi = 0;
for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
  const f = fbm(x / 256, y / 256, 6, 4);
  mn = Math.min(mn, f); mx = Math.max(mx, f); sum += f; n++;
  if (f > 0.45) hi++;
}
console.log('R channel: min', mn.toFixed(3), 'max', mx.toFixed(3), 'mean', (sum / n).toFixed(3), 'frac>0.45', (hi / n).toFixed(3));
