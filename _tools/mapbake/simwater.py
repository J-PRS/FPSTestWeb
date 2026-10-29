#!/usr/bin/env python3
"""
simwater.py — Phase 2 of sim-sculpted terrain: HYDRAULIC EROSION.

Two modes:
  1. Droplet-based (default): spawn water droplets that flow downhill, eroding
     terrain and depositing sediment where they slow. Creates natural channels.
  2. Flow-accumulation (--accumulate): compute flow accumulation from the
     terrain and erode proportionally. More efficient, produces better channels.

Reads a .bin (8-byte LE w,h + uint8 grid), writes a .bin. Reads sibling
<name>.json for heightScale/tileSize. Deterministic (seeded).

Usage:
  python simwater.py <in.bin> <out.bin> [opts]
  python simwater.py maps/rock.bin maps/water.bin --drops=5000 --seed=7
  python simwater.py maps/rock.bin maps/water.bin --accumulate --seed=7

Opts:
  --drops=N            number of water droplets (default 5000)
  --maxSteps=N         max steps per droplet (default 500)
  --erosionRate=R      erosion rate (default 0.3)
  --depositionRate=R   deposition rate (default 0.3)
  --evaporation=R      water evaporation rate (default 0.01)
  --capacity=C         sediment capacity multiplier (default 4.0)
  --minSlope=S         minimum slope to flow (default 0.01)
  --accumulate         use flow-accumulation mode instead of droplets
  --flowStrength=R     erosion strength for flow-accumulation (default 0.5)
  --seed=S             RNG seed (default 7)
  --smoothBase=N       apply N passes of gentle smoothing (default 1)
"""
import argparse
import json
import os
import struct
import numpy as np

parser = argparse.ArgumentParser(description='Hydraulic erosion terrain sculptor')
parser.add_argument('in_bin', help='input .bin heightmap')
parser.add_argument('out_bin', help='output .bin heightmap')
parser.add_argument('--drops', type=int, default=5000)
parser.add_argument('--maxSteps', type=int, default=500)
parser.add_argument('--erosionRate', type=float, default=0.3)
parser.add_argument('--depositionRate', type=float, default=0.3)
parser.add_argument('--evaporation', type=float, default=0.01)
parser.add_argument('--capacity', type=float, default=4.0)
parser.add_argument('--minSlope', type=float, default=0.01)
parser.add_argument('--accumulate', action='store_true', help='use flow-accumulation mode')
parser.add_argument('--flowStrength', type=float, default=0.5)
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

if args.accumulate:
    # --- Flow-accumulation mode ---
    print(f"simwater: flow-accumulation mode (seed {args.seed})")
    
    # Compute steepest descent direction for each cell
    gy, gx = np.gradient(h)
    # For each cell, find the neighbor with the lowest height
    # Use 8-connected neighbors
    # Flow direction: toward the steepest descent
    
    # Compute flow accumulation using a simple approach:
    # 1. Sort cells by height (highest first)
    # 2. For each cell, add its flow to its downhill neighbor
    
    # Find downhill neighbor for each cell
    # Use np.roll to check 8 neighbors
    neighbors = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            shifted = np.roll(np.roll(h, dy, axis=0), dx, axis=1)
            neighbors.append((dy, dx, shifted))
    
    # For each cell, find the neighbor with the lowest height
    # (steepest descent)
    best_dy = np.zeros((N, N), dtype=int)
    best_dx = np.zeros((N, N), dtype=int)
    best_height = h.copy()
    
    for dy, dx, shifted in neighbors:
        mask = shifted < best_height
        best_height = np.where(mask, shifted, best_height)
        best_dy = np.where(mask, dy, best_dy)
        best_dx = np.where(mask, dx, best_dx)
    
    # Flow accumulation: count how many cells flow through each cell
    flow_acc = np.ones((N, N), dtype=np.float64)
    
    # Sort cells by height (highest first) and accumulate
    flat_indices = np.argsort(h.flatten())[::-1]  # highest first
    for idx in flat_indices:
        y = idx // N
        x = idx % N
        dy = int(best_dy[y, x])
        dx = int(best_dx[y, x])
        ny = (y + dy) % N
        nx = (x + dx) % N
        flow_acc[ny, nx] += flow_acc[y, x]
    
    # Erode proportionally to flow accumulation
    # More flow = more erosion
    flow_norm = flow_acc / flow_acc.max()
    erosion = args.flowStrength * flow_norm * np.exp(-flow_norm * 2)
    h -= erosion * m_per_unit * 0.1
    
    # Deposit in flat areas (where flow accumulates)
    deposit_mask = flow_norm > 0.5
    h[deposit_mask] += args.flowStrength * 0.05 * m_per_unit
    
    h = np.clip(h, 0, None)
    
    print(f"  flow accumulation: max={flow_acc.max():.0f}, mean={flow_acc.mean():.1f}")
    print(f"  erosion applied: max={erosion.max():.4f}, mean={erosion.mean():.4f}")
else:
    # --- Droplet-based mode ---
    print(f"simwater: dropping {args.drops} water droplets (seed {args.seed})")
    
    def sample_height(x, z):
        x = x % N; z = z % N
        x0 = int(np.floor(x)) % N; z0 = int(np.floor(z)) % N
        x1 = (x0 + 1) % N; z1 = (z0 + 1) % N
        fx = x - np.floor(x); fz = z - np.floor(z)
        return (h[z0, x0] * (1-fx) * (1-fz) +
                h[z0, x1] * fx * (1-fz) +
                h[z1, x0] * (1-fx) * fz +
                h[z1, x1] * fx * fz)
    
    def sample_gradient(x, z):
        eps = 0.5
        h_px = sample_height(x + eps, z)
        h_mx = sample_height(x - eps, z)
        h_pz = sample_height(x, z + eps)
        h_mz = sample_height(x, z - eps)
        gx = (h_px - h_mx) / (2 * eps * texel)
        gz = (h_pz - h_mz) / (2 * eps * texel)
        return gx, gz
    
    def deposit(x, z, amount):
        x = x % N; z = z % N
        x0 = int(np.floor(x)) % N; z0 = int(np.floor(z)) % N
        x1 = (x0 + 1) % N; z1 = (z0 + 1) % N
        fx = x - np.floor(x); fz = z - np.floor(z)
        w00 = (1-fx)*(1-fz); w10 = fx*(1-fz)
        w01 = (1-fx)*fz; w11 = fx*fz
        h[z0, x0] += amount * w00
        h[z0, x1] += amount * w10
        h[z1, x0] += amount * w01
        h[z1, x1] += amount * w11
    
    def erode(x, z, amount):
        x = x % N; z = z % N
        x0 = int(np.floor(x)) % N; z0 = int(np.floor(z)) % N
        x1 = (x0 + 1) % N; z1 = (z0 + 1) % N
        fx = x - np.floor(x); fz = z - np.floor(z)
        w00 = (1-fx)*(1-fz); w10 = fx*(1-fz)
        w01 = (1-fx)*fz; w11 = fx*fz
        h[z0, x0] -= amount * w00
        h[z0, x1] -= amount * w10
        h[z1, x0] -= amount * w01
        h[z1, x1] -= amount * w11
        np.clip(h, 0, None, out=h)
    
    min_water = 0.01
    drop_capacity = args.capacity
    
    for drop in range(args.drops):
        best_z, best_x = 0, 0
        best_h = -1
        for _ in range(5):
            zx = int(rng.integers(0, N))
            zz = int(rng.integers(0, N))
            if h[zz, zx] > best_h:
                best_h = h[zz, zx]; best_x = zx; best_z = zz
        
        x = float(best_x) + 0.5
        z = float(best_z) + 0.5
        vx, vz = 0.0, 0.0
        water = 1.0
        sediment = 0.0
        prev_height = sample_height(x, z)
        
        for step in range(args.maxSteps):
            gx, gz = sample_gradient(x, z)
            slope = np.hypot(gx, gz)
            
            if slope < args.minSlope:
                deposit(x, z, sediment)
                sediment = 0
                break
            
            vx = vx * 0.9 + (-gx / slope) * 0.1
            vz = vz * 0.9 + (-gz / slope) * 0.1
            vlen = np.hypot(vx, vz)
            if vlen > 1e-6:
                vx /= vlen; vz /= vlen
            speed = min(vlen * 2, 10.0)
            
            new_x = x + vx
            new_z = z + vz
            new_height = sample_height(new_x, new_z)
            height_diff = prev_height - new_height
            
            capacity = speed * water * drop_capacity
            
            if sediment > capacity:
                deposit_amount = (sediment - capacity) * args.depositionRate
                deposit(x, z, deposit_amount)
                sediment -= deposit_amount
            elif height_diff > 0:
                erode_amount = min(height_diff, args.erosionRate) * speed
                erode(new_x, new_z, erode_amount)
                sediment += erode_amount
            else:
                deposit_amount = -height_diff * args.depositionRate
                deposit(x, z, deposit_amount)
                sediment -= deposit_amount
                sediment = max(0, sediment)
            
            water *= (1 - args.evaporation)
            if water < 0.01:
                water = 0.01
            
            x = new_x % N
            z = new_z % N
            prev_height = new_height
            
            if water < 0.01 and sediment < 0.01:
                deposit(x, z, sediment)
                break
        
        if sediment > 0:
            deposit(x, z, sediment)
        
        if drop % 1000 == 0:
            print(f"  {drop}/{args.drops} drops done")
    
    print(f"  all {args.drops} drops done")

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

print(f"simwater: wrote {args.out_bin} ({N}x{N})")
print(f"  relief: {(mx - mn) * m_per_unit:.1f}m -> 125.0m (normalized), sd: {h.std() * 125:.1f}m")
