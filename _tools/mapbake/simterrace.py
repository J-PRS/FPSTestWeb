#!/usr/bin/env python3
"""
simterrace.py — Stepped strata / terraced levels for sim-sculpted terrain.

Snaps heights to horizontal bands — mesa benches like Desiccator's strata.
The quantize blend is smoothstep over an edge fraction of each band, so
the flats stay flat and the cliff bands rise over a few meters instead of
one texel: ski can still climb some benches, mortars can't sit on a ramp.

Reads a .bin (8-byte LE w,h + uint8 grid), writes a .bin. Reads sibling
<name>.json for heightScale/tileSize. Deterministic.

Usage:
  python simterrace.py <in.bin> <out.bin> [opts]
  python simterrace.py maps/tect.bin maps/terraced.bin --step=16 --edge=0.25

Opts:
  --step=S      terrace height in meters (default 16)
  --edge=E      band-edge blend fraction 0..0.5 (default 0.25; smaller =
                harder cliffs, larger = ramps between benches)
  --soft=S      global pre-smoothing passes so bands follow big landforms
                not noise carpet (default 2)
"""
import argparse
import json
import os
import struct
import numpy as np

parser = argparse.ArgumentParser(description='Terraced strata terrain sculptor')
parser.add_argument('in_bin', help='input .bin heightmap')
parser.add_argument('out_bin', help='output .bin heightmap')
parser.add_argument('--step', type=float, default=16.0)
parser.add_argument('--edge', type=float, default=0.25)
parser.add_argument('--soft', type=int, default=2)
args = parser.parse_args()

with open(args.in_bin, 'rb') as f:
    buf = f.read()
N = struct.unpack('<I', buf[:4])[0]
Nh = struct.unpack('<I', buf[4:8])[0]
assert N == Nh, f"bad header: {N}x{Nh}"
assert len(buf) == 8 + N * N, f"bad size: {len(buf)} vs {8 + N*N}"
h = np.frombuffer(buf[8:], dtype=np.uint8).reshape(N, N).astype(np.float64)

spec_path = args.in_bin.replace('.bin', '.json')
hs = 1.0; tile = 1500.0
if os.path.exists(spec_path):
    with open(spec_path) as f:
        spec = json.load(f)
    hs = spec.get('heightScale', 1.0)
    tile = spec.get('tileSize', 1500.0)
m_per_unit = 125.0 * hs

h = h / 255.0 * m_per_unit

# Pre-smooth so the bands track the landform, not the surface carpet.
for _ in range(args.soft):
    h = (np.roll(h, 1, 0) + np.roll(h, -1, 0) +
         np.roll(h, 1, 1) + np.roll(h, -1, 1) + 4 * h) / 8.0

step = args.step
e = np.clip(args.edge, 0.01, 0.49)

t = h / step
f = np.mod(t, 1.0)
# smoothstep blend across the middle of the band: flats get f<0.5-e -> 0,
# f>0.5+e -> 1; the transition zone rounds the cliff edge instead of a
# 1-texel snap. Values ride up to the NEXT level mid-band.
s = np.clip((f - (0.5 - e)) / (2 * e), 0.0, 1.0)
s = s * s * (3 - 2 * s)
h = (np.floor(t) + s) * step

mn, mx = h.min(), h.max()
if mx - mn > 1e-6:
    h = (h - mn) / (mx - mn)

out_bytes = np.round(np.clip(h, 0, 1) * 255).astype(np.uint8)
with open(args.out_bin, 'wb') as f:
    f.write(struct.pack('<II', N, N))
    f.write(out_bytes.tobytes())

levels = int(round((mx - mn) / step)) + 1
print(f"simterrace: wrote {args.out_bin} ({N}x{N})")
print(f"  {levels} levels x {step}m, edge {e:.2f} of band")
