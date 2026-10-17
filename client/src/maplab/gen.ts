// maplab field synth — browser port of _tools/mapbake/genmap.js. Same
// periodic lattice + fBm/ridged/warp/features so generated fields are
// tileable by construction (the clipmap RepeatWrapping never seams).
// Adds what genmap doesn't have: droplet hydraulic erosion + thermal
// talus — the carving pass that turns noise into drainage valleys.
export interface GenParams {
  size: number;        // grid N (field is N×N, world wraps)
  seed: number;
  freq: number;        // octave ladder scale (1 = genmap's 4,9,20,44)
  detail: number;      // high-octave amplitude scale
  warp: number;
  ridge: number;       // 0 = fBm, 1 = ridged multifractal
  elong: number;       // dune ridges along z
  tilt: number; tiltAxis: 'x' | 'z';
  bowlR: number; bowlDepth: number;      // center-anchored crater (m)
  plateauR: number; plateauLift: number;
  seaR: number; seaDepth: number;
  vscale: number;
  // erosion (0 droplets = off)
  droplets: number; inertia: number; erodeRate: number;
  depositRate: number; evap: number; capacity: number;
  // Stream-power incision (D8 drainage network): K * acc^0.5 * slope,
  // iterated — carves a coherent valley network, not droplet scars.
  stream: number; streamIters: number;
  talus: number;       // thermal smoothing iterations
  talusAngle: number;  // slope threshold in 0..1 field units / cell
}

export const DEFAULTS: GenParams = {
  size: 257, seed: 7, freq: 1, detail: 1, warp: 0.6, ridge: 0, elong: 1,
  tilt: 0, tiltAxis: 'x',
  bowlR: 0, bowlDepth: 0.4, plateauR: 0, plateauLift: 0.5, seaR: 0, seaDepth: 0.5,
  vscale: 1,
  droplets: 0, inertia: 0.3, erodeRate: 0.35, depositRate: 0.3,
  evap: 0.02, capacity: 4,
  stream: 0, streamIters: 3,
  talus: 0, talusAngle: 0.02,
};

const WORLD = 1500;

function lattice(ix: number, iz: number, oct: number, seed: number): number {
  const s = Math.sin(ix * 127.1 + iz * 311.7 + oct * 74.7 + seed * 19.3) * 43_758.5453;
  return s - Math.floor(s);
}
const fade = (t: number): number => t * t * (3 - 2 * t);
function noise(u: number, v: number, cells: number, oct: number, seed: number): number {
  const x = u * cells, z = v * cells;
  const x0 = ((Math.floor(x) % cells) + cells) % cells, z0 = ((Math.floor(z) % cells) + cells) % cells;
  const x1 = (x0 + 1) % cells, z1 = (z0 + 1) % cells;
  const fx = fade(x - Math.floor(x)), fz = fade(z - Math.floor(z));
  return lattice(x0, z0, oct, seed) * (1 - fx) * (1 - fz) +
    lattice(x1, z0, oct, seed) * fx * (1 - fz) +
    lattice(x0, z1, oct, seed) * (1 - fx) * fz +
    lattice(x1, z1, oct, seed) * fx * fz;
}

function mulberry(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6D_2B_79_F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_00_00_00_00;
  };
}

/** Raw synth field in 0..1 — no erosion. */
export function synthField(p: GenParams): Float32Array {
  const N = p.size;
  const OCT = [4, 9, 20, 44, 88].map((c) => Math.max(1, Math.round(c * p.freq)));
  const AMP = [1, 0.62, 0.38, 0.22, 0.12].map((a, i) => a * (i === 0 ? 1 : p.detail));
  const fbmAt = (u: number, v: number): number => {
    let h = 0;
    for (let i = 0; i < OCT.length; i += 1) { h += noise(u * p.elong, v, OCT[i]!, i, p.seed) * AMP[i]!; }
    return h;
  };
  const ridgedAt = (u: number, v: number): number => {
    let h = 0, w = 1;
    for (let i = 0; i < OCT.length; i += 1) {
      const n = 1 - Math.abs(2 * noise(u * p.elong, v, OCT[i]!, i + 31, p.seed) - 1);
      h += n * n * w * AMP[i]!; w *= 0.85;
    }
    return h;
  };
  const fwarp = (u: number, v: number, k: number): number =>
    (noise(u + 1.7, v + 9.2, 3, 7, p.seed) - 0.5) * 2 * k;
  const twrap = (d: number, size: number): number => Math.min(d, size - d);
  const h = new Float32Array(N * N);
  for (let z = 0; z < N; z += 1) {
    for (let x = 0; x < N; x += 1) {
      const u = x / N, v = z / N;
      let wu = u, wv = v;
      if (p.warp > 0) {
        wu = u + p.warp * (noise(u + 1.7, v + 9.2, 4, 11, p.seed) - 0.5) * 0.25;
        wv = v + p.warp * (noise(u + 8.3, v + 2.8, 4, 12, p.seed) - 0.5) * 0.25;
      }
      let hh = p.ridge > 0 ? fbmAt(wu, wv) * (1 - p.ridge) + ridgedAt(wu, wv) * p.ridge : fbmAt(wu, wv);
      if (p.tilt !== 0) { hh += p.tilt * (1 - Math.cos(2 * Math.PI * (p.tiltAxis === 'z' ? v : u))) * 0.5; }
      const wx = (u - 0.5) * WORLD + fwarp(u, v, 1) * 45;
      const wz = (v - 0.5) * WORLD + fwarp(u + 5, v + 3, 1) * 45;
      const tdist = (fx: number, fz: number): number =>
        Math.hypot(twrap(Math.abs(wx - fx), WORLD), twrap(Math.abs(wz - fz), WORLD));
      if (p.bowlR > 0) {
        const t = Math.max(0, 1 - tdist(0, 0) / p.bowlR);
        hh -= p.bowlDepth * t * t * (3 - 2 * t);
      }
      if (p.plateauR > 0) {
        const t = Math.min(1, Math.max(0, (p.plateauR - tdist(0, 0)) / 60));
        const s = t * t * (3 - 2 * t);
        hh += p.plateauLift * s;
      }
      if (p.seaR > 0) {
        const t = Math.min(1, Math.max(0, (tdist(0, 0) - p.seaR) / 90));
        hh -= p.seaDepth * t;
      }
      h[z * N + x] = hh;
    }
  }
  // Normalize into 0..1 (the u8 dump uses the full range).
  let mn = Infinity, mx = -Infinity;
  for (const v of h) { if (v < mn) { mn = v; } if (v > mx) { mx = v; } }
  const inv = 1 / Math.max(1e-6, mx - mn);
  for (let i = 0; i < h.length; i += 1) { h[i] = (h[i] - mn) * inv; }
  return h;
}

/** Droplet hydraulic erosion (Beyer-style): each droplet follows the
 *  gradient, picks up sediment while it's steep+fast, drops it when it
 *  slows or ponds — carves drainage channels + deposits fans. Positions
 *  wrap toroidally so the eroded field stays tileable. */
export function erode(h: Float32Array, N: number, p: GenParams): void {
  const rand = mulberry(p.seed * 265_536_491);
  const at = (x: number, z: number): number =>
    h[(((Math.floor(z) % N) + N) % N) * N + (((Math.floor(x) % N) + N) % N)]!;
  const grad = (x: number, z: number, out: [number, number]): void => {
    out[0] = at(x + 1, z) - at(x - 1, z);
    out[1] = at(x, z + 1) - at(x, z - 1);
  };
  const spread = (x: number, z: number, dh: number): void => {
    const x0 = Math.floor(x), z0 = Math.floor(z), fx = x - x0, fz = z - z0;
    const w = [(1 - fx) * (1 - fz), fx * (1 - fz), (1 - fx) * fz, fx * fz];
    const idx = [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (let i = 0; i < 4; i += 1) {
      const xi = ((x0 + idx[i]![0]) % N + N) % N, zi = ((z0 + idx[i]![1]) % N + N) % N;
      h[zi * N + xi] = h[zi * N + xi]! + dh * w[i]!;
    }
  };
  const g: [number, number] = [0, 0];
  for (let d = 0; d < p.droplets; d += 1) {
    let x = rand() * N, z = rand() * N;
    let dx = 0, dz = 0, vel = 1, water = 1, sed = 0;
    for (let step = 0; step < 60; step += 1) {
      grad(x, z, g);
      dx = dx * p.inertia - g[0] * (1 - p.inertia);
      dz = dz * p.inertia - g[1] * (1 - p.inertia);
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      const px = x, pz = z;
      x += dx; z += dz;
      if (x < 0 || x >= N - 1 || z < 0 || z >= N - 1) { break; }
      const dh = at(px, pz) - at(x, z);
      const cap = Math.max(dh, p.talusAngle) * vel * water * p.capacity;
      if (sed > cap || dh > 0) {
        const dep = dh > 0 ? Math.min(dh, sed) : (sed - cap) * p.depositRate;
        sed -= dep;
        spread(px, pz, dep);
      } else {
        const take = Math.min((cap - sed) * p.erodeRate, -dh);
        sed += take;
        spread(px, pz, -take);
      }
      vel = Math.sqrt(Math.max(0, vel * vel + dh * 4));
      water *= 1 - p.evap;
      if (water < 0.05) { break; }
    }
  }
}

// --- D8 drainage ---
// Priority-flood + steepest-descent receivers + upstream accumulation.
// The D8 network is the coherent version of droplet scars: every cell
// routes downhill, so the accumulation field IS the river map — and a
// rough proxy for where a capper's lines converge.

/** Priority-flood depression fill (Barnes): raise closed basins to their
 *  lowest outlet so every cell drains to the tile edge. Returns a filled
 *  copy — the caller keeps eroding the real field, flood is only for
 *  routing. */
function priorityFlood(h: Float32Array, N: number): Float32Array {
  const f = h.slice();
  const done = new Uint8Array(N * N);
  // Min-heap on [height, idx].
  const heap: number[] = [];
  const push = (v: number): void => {
    heap.push(v);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p]! <= heap[i]!) { break; } [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p; }
  };
  const pop = (): number => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < heap.length && heap[l]! < heap[s]!) { s = l; }
        if (r < heap.length && heap[r]! < heap[s]!) { s = r; }
        if (s === i) { break; }
        [heap[s], heap[i]] = [heap[i]!, heap[s]!]; i = s;
      }
    }
    return top;
  };
  for (let x = 0; x < N; x += 1) { // tile boundary is the ocean
    for (const i of [x, (N - 1) * N + x, x * N, x * N + N - 1]) {
      if (!done[i]) { done[i] = 1; push(f[i]! * 1e7 + i); }
    }
  }
  while (heap.length > 0) {
    const top = pop();
    const i = Math.round(top % 1e7), ih = f[i]!;
    const x = i % N, z = (i / N) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nx >= N || nz < 0 || nz >= N) { continue; }
      const ni = nz * N + nx;
      if (done[ni]) { continue; }
      done[ni] = 1;
      if (f[ni]! < ih) { f[ni] = ih + 1e-6; } // fill the pit to the spill level
      push(f[ni]! * 1e7 + ni);
    }
  }
  return f;
}

export interface Drainage {
  acc: Float32Array;   // upstream cell count per cell
  rec: Int32Array;     // receiver index per cell (-1 = edge outlet)
}

export function drainage(h: Float32Array, N: number): Drainage {
  const f = priorityFlood(h, N);
  const rec = new Int32Array(N * N).fill(-1);
  const acc = new Float32Array(N * N).fill(1);
  for (let z = 0; z < N; z += 1) {
    for (let x = 0; x < N; x += 1) {
      const i = z * N + x;
      let worst = 0, wn = -1;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nx >= N || nz < 0 || nz >= N) { continue; }
        const ni = nz * N + nx;
        const d = (f[i]! - f[ni]!) / Math.hypot(dx, dz);
        if (d > worst) { worst = d; wn = ni; }
      }
      rec[i] = wn;
    }
  }
  // Accumulate upstream→downstream: process cells by descending filled
  // height — a cell always resolves before its receiver.
  const order = [...Array(N * N).keys()].sort((a, b) => f[b]! - f[a]!);
  for (const i of order) { const r = rec[i]; if (r >= 0) { acc[r] = acc[r]! + acc[i]!; } }
  return { acc, rec };
}

/** Stream-power incision: each step cuts `stream · acc^0.5 · slope` along
 *  the D8 network — where drainage converges the channel deepens, so a
 *  coherent valley system appears instead of noise gullies. Cutting is
 *  floor-limited at the receiver so channels never carve closed pits. */
export function streamPower(h: Float32Array, N: number, p: GenParams): void {
  if (p.stream <= 0) { return; }
  for (let it = 0; it < p.streamIters; it += 1) {
    const { acc, rec } = drainage(h, N);
    const src = h.slice();
    for (let i = 0; i < N * N; i += 1) {
      const r = rec[i];
      if (r < 0) { continue; }
      const dx = (i % N) - (r % N), dz = ((i / N) | 0) - ((r / N) | 0);
      const dist = Math.hypot(dx, dz);
      const slope = (src[i]! - src[r]!) / dist;
      const cut = p.stream * Math.sqrt(acc[i]!) * Math.max(0, slope) * 0.02;
      h[i] = Math.max(src[r]!, src[i]! - cut);
    }
  }
}

/** Thermal talus pass — material on slopes steeper than the angle slides
 *  to the downhill neighbor. Builds the repose aprons under cliffs. */
export function talusPass(h: Float32Array, N: number, p: GenParams): void {
  for (let it = 0; it < p.talus; it += 1) {
    const src = h.slice();
    for (let z = 0; z < N; z += 1) {
      for (let x = 0; x < N; x += 1) {
        const i = z * N + x;
        let worst = 0, wn = -1;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = (((z + dz) % N + N) % N) * N + (((x + dx) % N + N) % N);
          const d = src[i]! - src[ni]!;
          if (d > worst) { worst = d; wn = ni; }
        }
        if (worst > p.talusAngle && wn >= 0) {
          const move = (worst - p.talusAngle) * 0.5;
          h[i] = h[i]! - move; h[wn] = h[wn]! + move;
        }
      }
    }
  }
}

/** Full pipeline → the .bin byte layout (u32 w,h + u8 field).
 *  Order: stream-power carves the macro drainage network, droplets add
 *  micro gullies, talus aprons the cliffs — big structure first. */
export function bake(p: GenParams): Uint8Array {
  const N = p.size;
  const h = synthField(p);
  streamPower(h, N, p);
  if (p.droplets > 0) { erode(h, N, p); }
  if (p.talus > 0) { talusPass(h, N, p); }
  const bytes = new Uint8Array(8 + N * N);
  for (let i = 0; i < N * N; i += 1) { bytes[8 + i] = Math.round(Math.min(1, Math.max(0, h[i]! * p.vscale)) * 255); }
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, N, true); dv.setUint32(4, N, true);
  return bytes;
}
