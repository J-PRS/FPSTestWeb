#!/usr/bin/env python3
"""
skisoak.py — Terrain skiability test: drop sliding balls and measure energy retention.

Simulates a skier sliding down the terrain (steepest descent) and measures:
  - run length: how far you can ski in one direction before stopping
  - elevation drop: how much height you lose (energy gain)
  - smoothness: how consistent the slope direction is (no sharp turns)
  - max slope: steepest grade encountered
  - skiability score: composite metric

Reads a .bin (8-byte LE w,h + uint8 grid). Reads sibling <name>.json for
heightScale/tileSize. Deterministic.

Usage:
  python skisoak.py <bin> [<bin> ...]
  python skisoak.py maps/*.bin
  python skisoak.py maps/crossing.bin maps/t2/katabatic/terrain.bin

Opts:
  --samples=N    number of starting positions (default: all cells, strided)
  --maxSteps=N   max steps per path (default 200)
  --seed=S       RNG seed (default 7)
"""
import argparse
import json
import os
import struct
import numpy as np

parser = argparse.ArgumentParser(description='Terrain skiability test')
parser.add_argument('bins', nargs='+', help='input .bin heightmaps')
parser.add_argument('--samples', type=int, default=0, help='number of starting positions (0=all, strided)')
parser.add_argument('--maxSteps', type=int, default=200)
parser.add_argument('--seed', type=int, default=7)
args = parser.parse_args()

def load_bin(path):
    with open(path, 'rb') as f:
        buf = f.read()
    N = struct.unpack('<I', buf[:4])[0]
    Nh = struct.unpack('<I', buf[4:8])[0]
    assert N == Nh
    assert len(buf) == 8 + N * N
    data = np.frombuffer(buf[8:], dtype=np.uint8).reshape(N, N).astype(np.float64)
    spec_path = path.replace('.bin', '.json')
    hs = 1.0; tile = 1500.0
    if os.path.exists(spec_path):
        with open(spec_path) as f:
            spec = json.load(f)
        hs = spec.get('heightScale', 1.0)
        tile = spec.get('tileSize', 1500.0)
    texel = tile / N
    h = data / 255.0 * 125.0 * hs  # meters
    return h, N, texel, tile, hs

def ski_path(h, N, texel, sx, sz, max_steps):
    """Trace steepest descent from (sx, sz). Returns (drop_m, length_m, max_slope_deg, smoothness, n_steps)."""
    x, z = float(sx), float(sz)
    path_x = [x]; path_z = [z]
    total_drop = 0.0
    max_slope = 0.0
    dir_changes = 0
    prev_dx, prev_dz = 0.0, 0.0
    steps = 0

    for _ in range(max_steps):
        # Find steepest descent among 8 neighbors (using bilinear height)
        best_slope = 0.0; best_dx = 0; best_dz = 0
        for dz in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dz == 0:
                    continue
                nx = int(round(x + dx)) % N
                nz = int(round(z + dz)) % N
                dist = np.hypot(dx, dz) * texel
                slope = (h[int(z) % N, int(x) % N] - h[nz, nx]) / dist
                if slope > best_slope:
                    best_slope = slope; best_dx = dx; best_dz = dz

        if best_slope < 0.05:  # too flat, stop
            break

        # Track direction changes (smoothness)
        if prev_dx != 0 or prev_dz != 0:
            if best_dx != prev_dx or best_dz != prev_dz:
                dir_changes += 1
        prev_dx, prev_dz = best_dx, best_dz

        # Move one step
        x = (x + best_dx) % N
        z = (z + best_dz) % N
        steps += 1

        # Track slope
        slope_deg = np.degrees(np.arctan(best_slope))
        max_slope = max(max_slope, slope_deg)

    # Compute total drop
    start_h = h[int(sz) % N, int(sx) % N]
    end_h = h[int(z) % N, int(x) % N]
    total_drop = start_h - end_h
    path_length = steps * texel
    smoothness = 1.0 - (dir_changes / max(steps, 1))

    return total_drop, path_length, max_slope, smoothness, steps

# --- run on each bin ---
print(f"{'field':<35} {'relief':>7} {'sd':>6} {'mean_run':>9} {'mean_drop':>10} {'max_drop':>9} {'mean_slp':>9} {'smooth':>7} {'score':>8}")
print("-" * 110)

for bin_path in args.bins:
    h, N, texel, tile, hs = load_bin(bin_path)
    name = os.path.relpath(bin_path).replace('\\', '/')

    # Sample starting positions (strided if --samples=0)
    if args.samples > 0:
        rng = np.random.default_rng(args.seed)
        starts = [(int(rng.integers(0, N)), int(rng.integers(0, N))) for _ in range(args.samples)]
    else:
        # Strided: every 8th cell
        starts = [(x, z) for z in range(0, N, 8) for x in range(0, N, 8)]

    drops = []; runs = []; maxslopes = []; smooths = []; steps_list = []
    for sx, sz in starts:
        drop, run_len, max_slp, smooth, steps = ski_path(h, N, texel, sx, sz, args.maxSteps)
        drops.append(drop)
        runs.append(run_len)
        maxslopes.append(max_slp)
        smooths.append(smooth)
        steps_list.append(steps)

    mean_run = np.mean(runs)
    mean_drop = np.mean(drops)
    max_drop = np.max(drops)
    mean_slp = np.mean(maxslopes)
    mean_smooth = np.mean(smooths)
    mean_steps = np.mean(steps_list)

    # Skiability score: (mean_drop * mean_run * smoothness) / (1 + steep_fraction)
    # Higher = better ski terrain
    steep_frac = np.mean([1 if s > 45 else 0 for s in maxslopes])
    score = (mean_drop * mean_run * mean_smooth) / (1 + steep_frac * 2)

    print(f"{name:<35} {h.max()-h.min():>7.1f} {h.std():>6.1f} {mean_run:>9.1f} {mean_drop:>10.1f} {max_drop:>9.1f} {mean_slp:>9.1f} {mean_smooth:>7.2f} {score:>8.0f}")

print()
print("Legend: relief=vertical range(m) sd=std dev(m) mean_run=avg ski distance(m) mean_drop=avg elevation loss(m)")
print("        max_drop=best single run elevation loss(m) mean_slp=avg max slope(deg) smooth=direction consistency (1=perfect)")
print("        score=skiability composite (higher=better)")
