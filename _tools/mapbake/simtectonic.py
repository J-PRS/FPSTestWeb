#!/usr/bin/env python3
"""
simtectonic.py — Tectonic uplift + fault lines for sim-sculpted terrain.

Simulates tectonic plate collisions to create mountain ranges and valleys.
Creates the large-scale landform structure that erosion then sculpts:
  - Uplift zones (mountain ranges) where plates collide
  - Rift zones (valleys/chasms) where plates separate
  - Fault lines (ridges/valleys along plate boundaries)

Reads a .bin (8-byte LE w,h + uint8 grid), writes a .bin. Reads sibling
<name>.json for heightScale/tileSize. Deterministic (seeded).

Usage:
  python simtectonic.py <in.bin> <out.bin> [opts]
  python simtectonic.py maps/flat.bin maps/tectonic.bin --plates=3 --uplift=80 --rift=40 --seed=7

Opts:
  --plates=N          number of tectonic plates (default 3)
  --uplift=R          uplift height in meters (default 80)
  --rift=R            rift depth in meters (default 40)
  --faultNoise=W      fault line noise strength 0..1 (default 0.4)
  --faultScale=S      fault line scale (wavelength in meters, default 200)
  --seed=S            RNG seed (default 7)
  --smoothBase=N      gentle smoothing passes (default 2)
"""
import argparse
import json
import os
import struct
import numpy as np
from scipy.ndimage import gaussian_filter


def toroidal_dist(x1, z1, x2, z2, size):
    dx = np.minimum(np.abs(x1 - x2), size - np.abs(x1 - x2))
    dz = np.minimum(np.abs(z1 - z2), size - np.abs(z1 - z2))
    return np.hypot(dx, dz)

parser = argparse.ArgumentParser(description='Tectonic uplift + fault lines terrain sculptor')
parser.add_argument('in_bin', help='input .bin heightmap')
parser.add_argument('out_bin', help='output .bin heightmap')
parser.add_argument('--plates', type=int, default=3)
parser.add_argument('--uplift', type=float, default=80.0)
parser.add_argument('--rift', type=float, default=40.0)
parser.add_argument('--faultNoise', type=float, default=0.4)
parser.add_argument('--faultScale', type=float, default=200.0)
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

h = data / 255.0 * m_per_unit
rng = np.random.default_rng(args.seed)

xs = np.arange(N); zs = np.arange(N)
WX, WZ = np.meshgrid((xs / N - 0.5) * tile, (zs / N - 0.5) * tile)
U = WX / tile + 0.5
V = WZ / tile + 0.5

# --- deterministic noise ---
def lattice(ix, iz, oct):
    s = np.sin(ix * 127.1 + iz * 311.7 + oct * 74.7 + args.seed * 19.3) * 43758.5453
    return s - np.floor(s)

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

# --- generate plate boundaries ---
# Create N-1 fault lines as random lines across the map
# Each line has: angle, offset, and a "type" (collision = uplift, separation = rift)
print(f"simtectonic: {args.plates} plates, uplift={args.uplift}m, rift={args.rift}m")

# Plate centers (random positions)
plate_centers = []
for i in range(args.plates):
    cx = (rng.random() - 0.5) * tile * 0.8
    cz = (rng.random() - 0.5) * tile * 0.8
    plate_centers.append((cx, cz))

# For each pair of plates, create a boundary
# The boundary is a line; on one side we uplift, on the other we rift
# We'll use distance to plate centers to determine which plate each cell belongs to

# Voronoi-like plate assignment: each cell belongs to the nearest plate center
plate_id = np.zeros((N, N), dtype=int)
for i, (cx, cz) in enumerate(plate_centers):
    d = toroidal_dist(WX, WZ, cx, cz, tile)
    if i == 0:
        plate_id[:] = 0
        min_dist = d.copy()
    else:
        mask = d < min_dist
        plate_id = np.where(mask, i, plate_id)
        min_dist = np.minimum(d, min_dist)

# --- uplift at plate boundaries (mountain ranges) ---
# Where two plates meet, create uplift
# Use the distance to the nearest plate boundary as the uplift zone
# A cell is on a boundary if its plate_id differs from a neighbor's

# Compute plate boundary mask
boundary_mask = np.zeros((N, N), dtype=bool)
for dy in (-1, 0, 1):
    for dx in (-1, 0, 1):
        if dx == 0 and dy == 0:
            continue
        shifted = np.roll(np.roll(plate_id, dy, axis=0), dx, axis=1)
        boundary_mask |= (shifted != plate_id)

# Uplift: raise terrain near boundaries (mountain ranges)
# Use a Gaussian around boundary cells
boundary_float = boundary_mask.astype(np.float64)
uplift_field = gaussian_filter(boundary_float, sigma=8) * args.uplift

# Rift: lower terrain in the "valley" between plateaus
# Find the plate with the lowest elevation and create a rift there
# (simplified: lower the center of the map)
center_dist = toroidal_dist(WX, WZ, 0, 0, tile)
rift_field = np.exp(-(center_dist / (tile * 0.3))**2) * args.rift

# --- fault line noise (warped ridges/valleys along boundaries) ---
fault_scale = args.faultScale / tile  # in grid units
fault_cells = int(tile / args.faultScale)
fault_noise = noise2d(U * (tile / args.faultScale), V * (tile / args.faultScale), fault_cells, 7)
fault_noise = (fault_noise - 0.5) * 2  # -1..1
fault_field = fault_noise * args.faultNoise * args.uplift * 0.3

# --- apply tectonic forces ---
h += uplift_field
h -= rift_field
h += fault_field * boundary_float

# Clip to positive
h = np.clip(h, 0, None)

# --- smooth base ---
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

print(f"simtectonic: wrote {args.out_bin} ({N}x{N}, {args.plates} plates)")
print(f"  uplift: {args.uplift}m, rift: {args.rift}m, faultNoise: {args.faultNoise}")
print(f"  relief: {(mx - mn) * m_per_unit:.1f}m -> 125.0m (normalized), sd: {h.std() * 125:.1f}m")
