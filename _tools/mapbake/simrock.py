#!/usr/bin/env python3
"""
simrock.py — Phase 1 of sim-sculpted terrain: ROCKFALL + MASS WASTING.

Simulates dropping rocks onto a terrain and letting them carve cirques with
talus aprons, followed by a mass-wasting (thermal erosion) pass that sheds
material off slopes steeper than the angle of repose. The rock is a TOOL that
disappears — only the impact scar + debris apron remain in the heightmap.

Reads a .bin (8-byte LE w,h + uint8 grid), writes a .bin. Reads sibling
<name>.json for heightScale/tileSize. Deterministic (seeded).

Usage:
  python simrock.py <in.bin> <out.bin> [opts]
  python simrock.py maps/flat.bin maps/rock.bin --rocks=20 --radius=50 --seed=7

Opts:
  --rocks=N            number of rocks to drop (default 12)
  --radius=R           base crater radius in meters (default 50)
  --craterDepth=D      crater well depth in meters (default 40)
  --rimRaise=R         debris rim raise in meters (default 15)
  --angleOfRepose=A    angle of repose in degrees (default 35)
  --massWasteIter=N    max mass-wasting iterations (default 500)
  --massWasteRate=R    blend rate per pass (default 0.05)
  --warp=W             crater rim warp strength 0..1 (default 0.3)
  --seed=S             RNG seed (default 7)
  --smoothBase=N       apply N passes of gentle smoothing (default 2)
"""
import argparse
import json
import os
import struct
import numpy as np
from scipy.ndimage import gaussian_filter

parser = argparse.ArgumentParser(description='Rockfall + mass-wasting terrain sculptor')
parser.add_argument('in_bin', help='input .bin heightmap')
parser.add_argument('out_bin', help='output .bin heightmap')
parser.add_argument('--rocks', type=int, default=12)
parser.add_argument('--radius', type=float, default=50.0)
parser.add_argument('--craterDepth', type=float, default=40.0)
parser.add_argument('--rimRaise', type=float, default=15.0)
parser.add_argument('--angleOfRepose', type=float, default=35.0)
parser.add_argument('--massWasteIter', type=int, default=500)
parser.add_argument('--massWasteRate', type=float, default=0.05)
parser.add_argument('--warp', type=float, default=0.3)
parser.add_argument('--seed', type=int, default=7)
parser.add_argument('--smoothBase', type=int, default=2)
args = parser.parse_args()

# --- read input .bin ---
with open(args.in_bin, 'rb') as f:
    buf = f.read()
N = struct.unpack('<I', buf[:4])[0]
Nh = struct.unpack('<I', buf[4:8])[0]
assert N == Nh, f"bad header: {N}x{Nh}"
assert len(buf) == 8 + N * N, f"bad size: {len(buf)} vs {8 + N*N}"
data = np.frombuffer(buf[8:], dtype=np.uint8).reshape(N, N).astype(np.float64)

spec_path = args.in_bin.replace('.bin', '.json')
hs = 1.0; tile = 1500.0
if os.path.exists(spec_path):
    with open(spec_path) as f:
        spec = json.load(f)
    hs = spec.get('heightScale', 1.0)
    tile = spec.get('tileSize', 1500.0)
texel = tile / N
m_per_unit = 125.0 * hs

# Convert to meters
h = data / 255.0 * m_per_unit

rng = np.random.default_rng(args.seed)

# --- deterministic noise (for crater warping) ---
def noise2d(u, v, cells, oct):
    x = u * cells; z = v * cells
    x0 = np.floor(x).astype(int) % cells
    z0 = np.floor(z).astype(int) % cells
    x1 = (x0 + 1) % cells; z1 = (z0 + 1) % cells
    fx = x - np.floor(x); fz = z - np.floor(z)
    def hsh(ix, iz):
        return (np.sin(ix * 127.1 + iz * 311.7 + oct * 74.7 + args.seed * 19.3) * 43758.5453) % 1.0
    a = hsh(x0, z0); b = hsh(x1, z0)
    c = hsh(x0, z1); d = hsh(x1, z1)
    return a*(1-fx)*(1-fz) + b*fx*(1-fz) + c*(1-fx)*fz + d*fx*fz

def toroidal_dist(wx, wz, fx, fz, world=tile):
    dx = np.minimum(np.abs(wx - fx), world - np.abs(wx - fx))
    dz = np.minimum(np.abs(wz - fz), world - np.abs(wz - fz))
    return np.hypot(dx, dz)

xs = np.arange(N); zs = np.arange(N)
WX, WZ = np.meshgrid((xs / N - 0.5) * tile, (zs / N - 0.5) * tile)
U = WX / tile + 0.5
V = WZ / tile + 0.5

tan_repose = np.tan(np.radians(args.angleOfRepose))

# --- steepest descent: walk downhill until slope < angle of repose ---
def settle(cx, cz):
    x, z = cx, cz
    for _ in range(80):
        best_slope = 0.0; best_dx = 0; best_dz = 0
        for dz in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dz == 0: continue
                nx = (x + dx) % N; nz = (z + dz) % N
                dist = np.hypot(dx, dz) * texel
                slope = (h[z, x] - h[nz, nx]) / dist
                if slope > best_slope:
                    best_slope = slope; best_dx = dx; best_dz = dz
        if best_slope <= tan_repose: break
        x = (x + best_dx) % N; z = (z + best_dz) % N
    return x, z

# --- carve a crater at (cx, cz) with radius r ---
def carve_crater(cx, cz, r, depth, rim):
    global h
    wx_c = (cx / N - 0.5) * tile
    wz_c = (cz / N - 0.5) * tile
    d = toroidal_dist(WX, WZ, wx_c, wz_c)
    rim_warp = 1 + args.warp * (noise2d(U + 1.7, V + 9.2, 3, 7) - 0.5) * 2
    r_w = r * rim_warp
    t = np.clip(1 - d / r_w, 0, 1)
    well = depth * t * t * (3 - 2 * t)
    sigma = r * 0.4
    ring_t = np.clip(1 - np.abs(d - r_w) / (sigma * 2), 0, 1)
    ring = rim * ring_t * ring_t * (3 - 2 * ring_t)
    h -= well
    h += ring
    np.clip(h, 0, None, out=h)

# --- drop rocks ---
print(f"simrock: dropping {args.rocks} rocks (radius ~{args.radius}m, seed {args.seed})")
for i in range(args.rocks):
    ix = int(rng.integers(0, N))
    iz = int(rng.integers(0, N))
    r = args.radius * float(rng.uniform(0.6, 1.4))
    depth = args.craterDepth * float(rng.uniform(0.7, 1.3))
    rim = args.rimRaise * float(rng.uniform(0.7, 1.3))
    cx, cz = settle(ix, iz)
    carve_crater(cx, cz, r, depth, rim)

# --- mass-wasting pass (thermal erosion, Gaussian-based) ---
# Instead of iterative flow-based mass-wasting (which oscillates), use
# Gaussian smoothing weighted by slope excess. This is stable and produces
# smooth terrain. The angle of repose controls how much smoothing is applied:
# steeper slopes get more smoothing. Iterate a few times to propagate.
print(f"simrock: mass-wasting (angle of repose {args.angleOfRepose}deg, {args.massWasteIter} passes)")
mw_iter = 0
for it in range(min(args.massWasteIter, 10)):
    gy, gx = np.gradient(h)
    slope = np.hypot(gx, gy) / texel  # m/m
    excess = np.maximum(0, slope - tan_repose)

    if excess.max() < 1e-4:
        break

    # Gaussian smoothing (sigma proportional to excess)
    h_smooth = gaussian_filter(h, sigma=2.0)
    blend = np.clip(excess * args.massWasteRate * 8, 0, 0.7)
    h_new = h * (1 - blend) + h_smooth * blend
    h_new = np.clip(h_new, 0, None)

    max_change = np.abs(h_new - h).max()
    h = h_new
    mw_iter = it + 1

    if max_change < 1e-5:
        break

print(f"  settled after {mw_iter} passes")

# --- base smoothing (remove fine noise that makes it read as "noise with craters") ---
for _ in range(args.smoothBase):
    h = (np.roll(h, 1, 0) + np.roll(h, -1, 0) +
         np.roll(h, 1, 1) + np.roll(h, -1, 1) + 4 * h) / 8.0
    h = np.clip(h, 0, None)

# --- normalize to full 0..1 range ---
mn, mx = h.min(), h.max()
if mx - mn > 1e-6:
    h = (h - mn) / (mx - mn)

# --- write output .bin ---
out_bytes = np.round(np.clip(h, 0, 1) * 255).astype(np.uint8)
with open(args.out_bin, 'wb') as f:
    f.write(struct.pack('<II', N, N))
    f.write(out_bytes.tobytes())

print(f"simrock: wrote {args.out_bin} ({N}x{N}, {args.rocks} rocks, {mw_iter} mw passes)")
print(f"  relief: {(mx - mn) * m_per_unit:.1f}m -> 125.0m (normalized), sd: {h.std() * 125:.1f}m")
