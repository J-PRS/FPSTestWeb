// Procedural heightfield → maps/<name>.bin (8-byte LE w,h + uint8 grid).
// Usage: node genfield.js <out.bin> [--size=513] [--seed=7]
//         [--flats=x,z,r[,x,z,r...]]   (world coords; pads flatten to mid)
//         [--smooth]  gentler octave mix — 8/16/32 cells instead of
//                     8/24/64; kills the jaggedy ridge texture the
//                     high-frequency layer adds on smooth fields
//
// Value noise: multi-octave sine-hash lattice, smoothstep-interpolated,
// tileable across the wrap so the clipmap's RepeatWrapping never seams.
// Field bytes land mid-high (~128 ± hills) so bases sit near map y=0.

const { writeFileSync } = await import('node:fs');

const args = process.argv.slice(2);
const out = args[0];
const opts = Object.fromEntries(args.slice(1).map(a => {
  const m = a.match(/^--(\w+)=(.*)$/);
  return m ? [m[1], m[2]] : [];
}));
if (!out) { console.error('usage: genfield.js <out.bin> [--size=513] [--seed=7] [--flats=x,z,r,...]'); process.exit(1); }

const N = Number(opts.size ?? 513);
const seed = Number(opts.seed ?? 7);
const flats = (opts.flats ?? '').split(';').filter(Boolean).map(s => s.split(',').map(Number));
// Craters: x,z,r,depth — depress the field so a structure roof over the
// bowl reads as an underground room without cutting the heightmap.
const craters = (opts.craters ?? '').split(';').filter(Boolean).map(s => s.split(',').map(Number));
// Quicksand layout: --moat=r1,r2,depth digs an annular ravine around the
// center; --mesa=hw raises a square plateau inside it (edge eases over
// ~15m of cliff so the lip isn't a razor).
const moat = (opts.moat ?? '').split(',').map(Number);
const mesa = (opts.mesa ?? '').split(',').map(Number); // hw[, lift]
// --rimring=x,z,r,raise — lifts a ring wall around a bowl so the rim is
// uniformly tall regardless of where the noise landed.
const rimring = (opts.rimring ?? '').split(',').map(Number);
const smooth = 'smooth' in opts;
const OCTAVES = smooth ? [[8, 0.55], [16, 0.30], [32, 0.15]] : [[8, 0.5], [24, 0.3], [64, 0.2]];
const WORLD = 1500; // HM_WORLD_SCALE — one heightmap wraps the arena

// Deterministic lattice hash → [0,1)
function lattice(ix, iz, oct) {
  const s = Math.sin(ix * 127.1 + iz * 311.7 + oct * 74.7 + seed * 19.3) * 43758.5453;
  return s - Math.floor(s);
}
const fade = t => t * t * (3 - 2 * t);
function noise(u, v, cells, oct) {
  const x = u * cells, z = v * cells;
  const x0 = Math.floor(x) % cells, z0 = Math.floor(z) % cells;
  const x1 = (x0 + 1) % cells, z1 = (z0 + 1) % cells;
  const fx = fade(x - Math.floor(x)), fz = fade(z - Math.floor(z));
  return lattice(x0, z0, oct) * (1 - fx) * (1 - fz) +
         lattice(x1, z0, oct) * fx * (1 - fz) +
         lattice(x0, z1, oct) * (1 - fx) * fz +
         lattice(x1, z1, oct) * fx * fz;
}

const bytes = new Uint8Array(8 + N * N);
for (let z = 0; z < N; z++) {
  for (let x = 0; x < N; x++) {
    const u = x / N, v = z / N;
    let h = 0;
    OCTAVES.forEach(([cells, amp], i) => { h += noise(u, v, cells, i) * amp; });
    const wx = (u - 0.5) * WORLD, wz = (v - 0.5) * WORLD;
    // Toroidal distance helper — pads/craters near the seam wrap cleanly.
    const tdist = (fx, fz) => Math.hypot(
      Math.min(Math.abs(wx - fx), WORLD - Math.abs(wx - fx)),
      Math.min(Math.abs(wz - fz), WORLD - Math.abs(wz - fz)),
    );
    // Craters dig the bowl — depth is in the same normalized units h
    // uses (≈45m at 1.0). Bucket profile: full depth across the inner
    // 2/3 (a flat floor a structure roof can span), easing to zero in
    // the outer third so the rim still wraps with the noise.
    let dig = 0;
    for (const [cx, cz, r, depth] of craters) {
      const d = tdist(cx, cz);
      dig = Math.max(dig, (depth ?? 0.3) * Math.min(1, Math.max(0, (1 - d / r) * 3)));
    }
    h = Math.max(0, h - dig);
    // Square mesa: Chebyshev distance to center < hw lifts the plateau to
    // a fixed shelf; moat annulus digs back down around it.
    if (mesa.length >= 1 && mesa[0] > 0) {
      const [hw, top] = mesa;
      const sq = Math.max(
        Math.min(Math.abs(wx), WORLD - Math.abs(wx)),
        Math.min(Math.abs(wz), WORLD - Math.abs(wz)),
      );
      const lift = Math.min(1, Math.max(0, (hw - sq) / 15));
      h = h * (1 - lift) + (top ?? 0.30) * lift;
    }
    if (moat.length === 3) {
      const [r1, r2, depth] = moat;
      const d = tdist(0, 0);
      const edge = Math.min(d - r1, r2 - d);
      const sink = Math.min(1, Math.max(0, edge / 14)) * depth;
      h = Math.max(0, h - sink);
    }
    if (rimring.length === 4) {
      const [cx, cz, r, raise] = rimring;
      // Organic crest: low-freq noise wanders the ring radius ±30m and
      // gates the lift 0.35-1x, so the wall reads as dune ridges with
      // natural saddles to ski through, not a machined torus.
      const rr = r + (noise(u, v, 3, 4) - 0.5) * 60;
      const d = tdist(cx, cz);
      const band = Math.max(0, 1 - Math.abs(d - rr) / 55);
      const jag = 0.35 + 0.65 * noise(u, v, 7, 5);
      h = Math.min(1, h + raise * band * jag);
    }
    let flat = 0;
    for (const [fx, fz, r] of flats) {
      flat = Math.max(flat, Math.min(1, Math.max(0, 1 - tdist(fx, fz) / (r * 2))));
    }
    // Specs author bases/spawns at y≈0 absolute — pads hug the valley
    // floor (~0-3m) and hills top out around 45m so geometry stays visible.
    h = h * (1 - flat) + 0.02 * flat;
    bytes[8 + z * N + x] = Math.round(Math.min(1, Math.max(0, h * 0.38)) * 255);
  }
}
new DataView(bytes.buffer).setUint32(0, N, true);
new DataView(bytes.buffer).setUint32(4, N, true);
writeFileSync(out, bytes);
console.log(`${out}: ${N}x${N} field, seed ${seed}, ${flats.length} flat pad(s)`);
