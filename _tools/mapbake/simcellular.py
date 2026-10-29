#!/usr/bin/env python3
"""
simcellular.py — Cellular automata weathering for terrain.

Applies simple, iterative rules to a heightmap that produce organic detail:
  - Rule 1 (weathering): peaks erode (cells higher than their neighbors shed material)
  - Rule 2 (deposition): depressions fill (cells lower than their neighbors accumulate)
  - Rule 3 (smoothing): steep edges soften (material moves downhill where slope > threshold)
  - Rule 4 (ridge sharpening): cells on ridges (high curvature) get slightly raised

Each rule is a "verb" applied to the heightmap. Run them in sequence or
individually. The result is organic, non-repeating detail that noise alone
can't produce.

Reads a .bin (8-byte LE w,h + uint8 grid), writes a .bin. Reads sibling
<name>.json for heightScale/tileSize. Deterministic (seeded).

Usage:
  python simcellular.py <in.bin> <out.bin> [opts]
  python simcellular.py maps/rock.bin maps/weathered.bin --passes=50 --seed=7

Opts:
  --passes=N           number of CA iterations (default 50)
  --weathering=R       weathering strength 0..1 (default 0.3)
  --deposition=R       deposition strength 0..1 (default 0.2)
  --smoothing=R        smoothing strength 0..1 (default 0.1)
  --ridgeBoost=R       ridge sharpening strength 0..1 (default 0.05)
  --angleOfRepose=A    angle of repose in degrees (default 35)
  --seed=S             RNG seed (default 7)
  --smoothBase=N       gentle smoothing passes (default 1)
"""
import argparse
import json
import os
import struct
import numpy as np

parser = argparse.ArgumentParser(description='Cellular automata weathering terrain sculptor')
parser.add_argument('in_bin', help='input .bin heightmap')
parser.add_argument('out_bin', help='output .bin heightmap')
parser.add_argument('--passes', type=int, default=50)
parser.add_argument('--weathering', type=float, default=0.3)
parser.add_argument('--deposition', type=float, default=0.2)
parser.add_argument('--smoothing', type=float, default=0.1)
parser.add_argument('--ridgeBoost', type=float, default=0.05)
parser.add_argument('--angleOfRepose', type=float, default=35.0)
parser.add_argument('--seed', type=int, default=7)
parser.add_argument('--smoothBase', type=int, default=1)
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

tan_repose = np.tan(np.radians(args.angleOfRepose))

# --- cellular automata rules ---
print(f"simcellular: {args.passes} passes (weathering={args.weathering}, deposition={args.deposition}, smoothing={args.smoothing})")

for it in range(args.passes):
    # 4-neighbor averages and gradients
    n_up = np.roll(h, 1, axis=0)
    n_down = np.roll(h, -1, axis=0)
    n_left = np.roll(h, 1, axis=1)
    n_right = np.roll(h, -1, axis=1)
    neighbor_avg = (n_up + n_down + n_left + n_right) / 4.0
    neighbor_max = np.maximum(np.maximum(n_up, n_down), np.maximum(n_left, n_right))
    neighbor_min = np.minimum(np.minimum(n_up, n_down), np.minimum(n_left, n_right))

    # Rule 1: Weathering — cells higher than their neighbors erode
    # (peaks shed material)
    height_diff = h - neighbor_avg
    weathering = np.where(height_diff > 0, height_diff * args.weathering, 0)

    # Rule 2: Deposition — cells lower than their neighbors accumulate
    # (depressions fill)
    deposition = np.where(height_diff < 0, -height_diff * args.deposition, 0)

    # Rule 3: Smoothing — steep cells blend toward neighbors
    gy, gx = np.gradient(h)
    slope = np.hypot(gx, gy) / texel
    excess = np.maximum(0, slope - tan_repose)
    smoothing = np.clip(excess * args.smoothing * 5, 0, 0.5)

    # Rule 4: Ridge sharpening — cells that are local maxima (ridges) get
    # slightly raised to create sharper ridge lines
    is_ridge = (h > neighbor_max - 0.1) & (h > neighbor_avg)
    ridge_boost = np.where(is_ridge, args.ridgeBoost, 0)

    # Apply all rules
    h_new = h - weathering + deposition
    neighbors_smooth = (n_up + n_down + n_left + n_right) / 4.0
    blend = np.clip(excess * args.smoothing * 5, 0, 0.4)
    h_new = h_new * (1 - blend) + neighbors_smooth * blend
    h_new += ridge_boost

    h_new = np.clip(h_new, 0, None)
    max_change = np.abs(h_new - h).max()
    h = h_new

    if max_change < 1e-6:
        print(f"  converged after {it + 1} passes")
        break
else:
    print(f"  ran {args.passes} passes")

# --- base smoothing ---
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

print(f"simcellular: wrote {args.out_bin} ({N}x{N})")
print(f"  relief: {(mx - mn) * m_per_unit:.1f}m -> 125.0m (normalized), sd: {h.std() * 125:.1f}m")