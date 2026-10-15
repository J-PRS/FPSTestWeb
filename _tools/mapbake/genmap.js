// genmap.js — Tribe-legible terrain fields for the custom maps. Same output
// format as genfield.js (8-byte LE w,h + uint8 grid).
//   bun _tools/mapbake/genmap.js <out.bin> [opts]
//
// Tuned against the real T2 ports shipped in maps/t2 (see terrainstats.js):
// those fields carry ~125m relief at heightScale 1 with sd ~20-30m and real
// energy from ~20m to ~200m feature size. genfield's fixed 8/24/64 octaves
// leave a smooth plain with a fine carpet — ski-legible terrain wants BIG,
// low-curvature hills you can bank off, not a bumpy plate. Two things make
// that happen here: (1) a wide fBm/ridged spectrum so energy survives at
// 50-300m, and (2) features (bowls, plateaus, sea) that are DOMAIN-WARPED
// into the noise instead of stamped as circles/squares.
//
// Everything is periodic (noise, warp, toroidal features, sinusoidal tilt),
// so the clipmap's RepeatWrapping never seams.
//
// Opts:
//   --size=513                 grid resolution
//   --seed=7                   lattice seed
//   --oct=4,9,20,44            octave cell counts (low->high); default 4,9,20,44
//   --amp=1,0.62,0.38,0.22     per-octave amplitude; default 1,0.62,0.38,0.22
//   --warp=0.6                 domain-warp strength (organic shapes, no new freq)
//   --ridge=0.5                blend a ridged multifractal (mountain ranges)
//   --bowl=x,z,r,depth[;...]   smooth warped depression (cirque / crater)
//   --plateau=x,z,r,lift,fall  soft-topped hill/mesa (warped radial edge)
//   --sea=r,depth              sink everything beyond radius r (lagoon)
//   --tilt=amp[:x|z]           one sinusoidal run across the tile
//   --flats=x,z,r[;...]        level pads for bases (blend to their own center)
//   --raw                      skip normalization (keep absolute h)
//   --vscale=0.38              u8 gain; with normalization + 1.0 => full 0..255
const { writeFileSync } = await import('node:fs');

const args = process.argv.slice(2);
const out = args[0];
const opts = {};
const lists = { bowl: [], plateau: [], flats: [] };
for (const a of args.slice(1)) {
  const m = a.match(/^--([\w-]+)=?(.*)$/);
  if (!m) { continue; }
  const [, key, val] = m;
  if (key in lists) { for (const rec of val.split(';').filter(Boolean)) { lists[key].push(rec.split(',').map(Number)); } }
  else { opts[key] = val === '' ? true : val; }
}
if (!out) { console.error('usage: genmap.js <out.bin> [--oct=4,9,20,44] [--ridge=0.5] [--bowl=x,z,r,depth] [--plateau=x,z,r,lift,fall] [--sea=r,depth] [--tilt=0.4:x] [--flats=x,z,r]'); process.exit(1); }

const N = Number(opts.size ?? 513);
const seed = Number(opts.seed ?? 7);
const WORLD = 1500;
const vscale = Number(opts.vscale ?? (opts.raw ? 0.38 : 1.0));
const OCT = (opts.oct ?? '4,9,20,44').split(',').map(Number);
const AMP = (opts.amp ?? '1,0.62,0.38,0.22').split(',').map(Number);
const warp = Number(opts.warp ?? 0.6);
const ridge = Number(opts.ridge ?? 0);
const tilt = String(opts.tilt ?? '').split(':'); const tiltAmp = Number(tilt[0] ?? 0), tiltAxis = tilt[1] ?? 'x';
const sea = String(opts.sea ?? '').split(',').map(Number);

function lattice(ix, iz, oct) {
  const s = Math.sin(ix * 127.1 + iz * 311.7 + oct * 74.7 + seed * 19.3) * 43758.5453;
  return s - Math.floor(s);
}
const fade = (t) => t * t * (3 - 2 * t);
function noise(u, v, cells, oct) {
  const x = u * cells, z = v * cells;
  const x0 = ((Math.floor(x) % cells) + cells) % cells, z0 = ((Math.floor(z) % cells) + cells) % cells;
  const x1 = (x0 + 1) % cells, z1 = (z0 + 1) % cells;
  const fx = fade(x - Math.floor(x)), fz = fade(z - Math.floor(z));
  return lattice(x0, z0, oct) * (1 - fx) * (1 - fz) +
         lattice(x1, z0, oct) * fx * (1 - fz) +
         lattice(x0, z1, oct) * (1 - fx) * fz +
         lattice(x1, z1, oct) * fx * fz;
}
// fBm and a ridged multifractal over the same octave set.
function fbmAt(u, v) { let h = 0; for (let i = 0; i < OCT.length; i += 1) { h += noise(u, v, OCT[i], i) * (AMP[i] ?? 0); } return h; }
function ridgedAt(u, v) { let h = 0, w = 1; for (let i = 0; i < OCT.length; i += 1) { const n = 1 - Math.abs(2 * noise(u, v, OCT[i], i + 31) - 1); h += n * n * w * (AMP[i] ?? 0); w *= 0.85; } return h; }

const h = new Float32Array(N * N);
// Feature warp: a gentle low-frequency displacement so bowls/plateaus/sea
// edges read as eroded landforms, not machined circles.
const fwarp = (u, v, k) => (noise(u + 1.7, v + 9.2, 3, 7) - 0.5) * 2 * k;
const twrap = (d, size) => Math.min(d, size - d); // toroidal fold for a 0..WORLD span

for (let z = 0; z < N; z += 1) {
  for (let x = 0; x < N; x += 1) {
    const u = x / N, v = z / N;
    let wu = u, wv = v;
    if (warp > 0) {
      wu = u + warp * (noise(u + 1.7, v + 9.2, 4, 11) - 0.5) * 0.25;
      wv = v + warp * (noise(u + 8.3, v + 2.8, 4, 12) - 0.5) * 0.25;
    }
    let hh = ridge > 0 ? fbmAt(wu, wv) * (1 - ridge) + ridgedAt(wu, wv) * ridge : fbmAt(wu, wv);

    if (tiltAmp !== 0) { hh += tiltAmp * (1 - Math.cos(2 * Math.PI * (tiltAxis === 'z' ? v : u))) * 0.5; }

    // Feature distances in warped world space (organic edges).
    const wx = (u - 0.5) * WORLD + fwarp(u, v, 1) * 45;
    const wz = (v - 0.5) * WORLD + fwarp(u + 5, v + 3, 1) * 45;
    const tdist = (fx, fz) => Math.hypot(twrap(Math.abs(wx - fx), WORLD), twrap(Math.abs(wz - fz), WORLD));
    for (const [fx, fz, r, depth] of lists.bowl) {
      if (!Number.isFinite(depth)) { continue; }
      const t = Math.max(0, 1 - tdist(fx, fz) / r);
      hh -= (depth ?? 0.4) * t * t * (3 - 2 * t); // smoothstep, no hard rim
    }
    for (const [fx, fz, r, lift, fall = 60] of lists.plateau) {
      if (!Number.isFinite(lift)) { continue; }
      const t = Math.min(1, Math.max(0, (r - tdist(fx, fz)) / fall));
      const s = t * t * (3 - 2 * t); // smooth toe
      hh += (lift ?? 0.5) * s;       // ADDITIVE: raise a mesa/dome, never a pit
    }
    if (sea.length >= 2) { const [r, depth, ramp = 90] = sea; const t = Math.min(1, Math.max(0, (tdist(0, 0) - r) / ramp)); hh -= (Number.isFinite(depth) ? depth : 0) * t; }

    h[z * N + x] = hh;
  }
}

// Normalize so the u8 dump uses the full range (this is what T2 does: byte
// 0..255 spans the map's 125m*hs relief) — but pads are levelled AFTER, to
// their own local centre, so a base never becomes a pit.
if (!opts.raw) {
  let mn = Infinity, mx = -Infinity;
  for (const v of h) { if (v < mn) { mn = v; } if (v > mx) { mx = v; } }
  const inv = 1 / Math.max(1e-6, mx - mn);
  for (let i = 0; i < h.length; i += 1) { h[i] = (h[i] - mn) * inv; }
}
for (const [fx, fz, r] of lists.flats) {
  // Pad centre in world space -> grid index.
  const cx = ((fx / WORLD + 0.5) * N) | 0, cz = ((fz / WORLD + 0.5) * N) | 0;
  const ci = ((cz % N) + N) % N * N + (((cx % N) + N) % N);
  const target = h[ci];
  for (let z = 0; z < N; z += 1) {
    for (let x = 0; x < N; x += 1) {
      const d = Math.hypot(twrap(Math.abs((x / N - 0.5) * WORLD - fx), WORLD), twrap(Math.abs((z / N - 0.5) * WORLD - fz), WORLD));
      if (d > r) { continue; }
      const t = 1 - d / r;
      const w = t * t * (3 - 2 * t);
      const i = z * N + x;
      h[i] = h[i] * (1 - w) + target * w;
    }
  }
}

const bytes = new Uint8Array(8 + N * N);
for (let i = 0; i < N * N; i += 1) { bytes[8 + i] = Math.round(Math.min(1, Math.max(0, h[i] * vscale)) * 255); }
const dv = new DataView(bytes.buffer);
dv.setUint32(0, N, true); dv.setUint32(4, N, true);
writeFileSync(out, bytes);
console.log(`${out}: ${N}x${N}, seed ${seed}, oct[${OCT}] ridge=${ridge} warp=${warp}, ${lists.bowl.length} bowl(s), ${lists.plateau.length} plateau(s), ${lists.flats.length} pad(s)`);
