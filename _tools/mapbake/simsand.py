#!/usr/bin/env python3
"""
simsand.py — Phase 3 of sim-sculpted terrain: GRANULAR FLOW (SAND).

Simulates pouring sand onto a terrain. Sand flows downhill where the slope
exceeds the angle of repose (~30deg), settling in bowls and creating scree
aprons at cliff bases. Unlike water (which erodes), sand DEPOSITS — it
fills depressions and smooths steep faces.

Reads a .bin (8-byte LE w,h + uint8 grid), writes a .bin. Reads sibling
<name>.json for heightScale/tileSize. Deterministic (seeded).

Usage:
  python simsand.py <in.bin> <out.bin> [opts]
  python simsand.py maps/water.bin maps/sand.bin --amount=0.3 --seed=7

Opts:
  --amount=R       amount of sand to pour (0..1, default 0.3)
  --angleOfRepose=A  angle of repose in degrees (default 30)
  --passes=N       max flow passes (default 100)
  --rate=R         flow rate per pass (default 0.1)
  --seed=S         RNG seed (default 7)
  --smoothBase=N   apply N passes of gentle smoothing (default 1)
"""
import argparse
import json
import os
import struct
import numpy as np

parser = argparse.ArgumentParser(description='Granular flow (sand) terrain sculptor')
parser.add_argument('in_bin', help='input .bin heightmap')
parser.add_argument('out_bin', help='output .bin heightmap')
parser.add_argument('--amount', type=float, default=0.3, help='amount of sand to pour (0..1)')
parser.add_argument('--angleOfRepose', type=float, default=30.0, help='angle of repose in degrees')
parser.add_argument('--passes', type=int, default=100, help='max flow passes')
parser.add_argument('--rate', type=float, default=0.1, help='flow rate per pass')
parser.add_argument('--seed', type=int, default=7, help='RNG seed')
parser.add_argument('--smoothBase', type=int, default=1, help='gentle smoothing passes')
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

# --- pour sand: add a layer of sand proportional to amount ---
sand_volume = args.amount * m_per_unit * 0.5  # meters of sand
h += sand_volume * (0.5 + 0.5 * np.random.default_rng(args.seed).random((N, N)))

# --- granular flow: sand slides where slope > angle of repose ---
tan_repose = np.tan(np.radians(args.angleOfRepose))
print(f"simsand: pouring sand (amount={args.amount}, angle of repose={args.angleOfRepose}deg)")

passes = 0
for it in range(args.passes):
    gy, gx = np.gradient(h)
    slope = np.hypot(gx, gy) / texel
    excess = np.maximum(0, slope - tan_repose)

    if excess.max() < 1e-6:
        break

    # Flow: move excess material downhill
    slope_safe = np.where(slope > 1e-6, slope, 1.0)
    flow_px = args.rate * excess * np.clip(-gx / slope_safe, 0, 1)
    flow_mx = args.rate * excess * np.clip(gx / slope_safe, 0, 1)
    flow_pz = args.rate * excess * np.clip(-gy / slope_safe, 0, 1)
    flow_mz = args.rate * excess * np.clip(gy / slope_safe, 0, 1)

    outflow = flow_px + flow_mx + flow_pz + flow_mz
    inflow = (np.roll(flow_mx, -1, axis=1) +
              np.roll(flow_px, 1, axis=1) +
              np.roll(flow_mz, -1, axis=0) +
              np.roll(flow_pz, 1, axis=0))

    h = h - outflow + inflow
    h = np.clip(h, 0, None)
    passes = it + 1

    # Check convergence
    if outflow.max() < 1e-6:
        break

print(f"  settled after {passes} passes")

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

print(f"simsand: wrote {args.out_bin} ({N}x{N})")
print(f"  relief: {(mx - mn) * m_per_unit:.1f}m -> 125.0m (normalized), sd: {h.std() * 125:.1f}m")
