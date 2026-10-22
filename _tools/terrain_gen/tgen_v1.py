#!/usr/bin/env python3
"""
Heightmap generator for FPSWebTest terrain system.

Generates seamlessly tileable grayscale PNG heightmaps compatible with the
client's terrain renderer. The R channel (0-255) encodes normalized height;
the client divides by TERRAIN_HEIGHTMAP_DIVISOR (255) and multiplies by
TERRAIN_HEIGHT_SCALE (125) for world-space height in meters.

The client's sampleHeightmap() uses fract(worldXZ / hmWorldScale) to wrap
the heightmap infinitely, so a tileable heightmap = seamless infinite terrain.

Tiling is achieved via perlin-numpy's periodic gradient lattice wrapping:
gradient coordinates are taken modulo the period, so edges match seamlessly.

Usage:
    python main.py generate --preset desert --size 2048 --output ../client/assets/heightmaps/desert.png
    python main.py generate --algorithm ridged --size 1024 --octaves 8 --res 4 --output out.png
    python main.py info ../client/assets/heightmaps/Vortex_Smooth2_2048.png
    python main.py preview out.png --output preview.png
    python main.py verify out.png

Requires: numpy, Pillow, perlin-numpy
    pip install perlin-numpy
"""

import argparse
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

try:
    from perlin_numpy import generate_fractal_noise_2d, generate_perlin_noise_2d
except ImportError:
    print("ERROR: perlin-numpy not installed. Run: pip install perlin-numpy")
    sys.exit(1)

# ─── Match client constants (client/src/core/config.ts) ────────────────────
CLIENT_HEIGHT_SCALE = 125.0       # TERRAIN_HEIGHT_SCALE
CLIENT_WORLD_SCALE = 1500.0       # TERRAIN_WORLD_SCALE
CLIENT_DIVISOR = 255.0            # TERRAIN_HEIGHTMAP_DIVISOR


# ═══════════════════════════════════════════════════════════════════════════
# Noise generation (seamlessly tileable via perlin-numpy)
# ═══════════════════════════════════════════════════════════════════════════

def _set_seed(seed: int):
    np.random.seed(seed)


def fbm_tileable(size: int, res: int, octaves: int, persistence: float,
                 lacunarity: int, seed: int) -> np.ndarray:
    """Tileable fractal Brownian motion noise in [-1, 1].

    Args:
        size: Output array dimension (must be divisible by res * lacunarity^(octaves-1))
        res: Number of grid cells for the lowest-frequency octave
        octaves: Number of noise octaves stacked
        persistence: Amplitude decay per octave
        lacunarity: Frequency growth per octave (must be integer for tiling)
        seed: Random seed
    """
    _set_seed(seed)
    return generate_fractal_noise_2d(
        (size, size), (res, res),
        octaves=octaves,
        persistence=persistence,
        lacunarity=lacunarity,
        tileable=(True, True),
    )


def ridged_tileable(size: int, res: int, octaves: int, persistence: float,
                    lacunarity: int, seed: int) -> np.ndarray:
    """Tileable ridged multifractal noise — sharp mountain ridges.

    Generates per-octave tileable Perlin and applies the ridged transform:
    ridged = (1 - |noise|)^2, then stacks with amplitude weighting.
    """
    total = np.zeros((size, size), dtype=np.float64)
    amplitude = 1.0
    max_amp = 0.0
    for o in range(octaves):
        _set_seed(seed + o * 1013)
        octave_res = res * (lacunarity ** o)
        noise = generate_perlin_noise_2d(
            (size, size), (octave_res, octave_res),
            tileable=(True, True),
        )
        ridged = (1.0 - np.abs(noise)) ** 2
        total += ridged * amplitude
        max_amp += amplitude
        amplitude *= persistence
    return total / max_amp


# ═══════════════════════════════════════════════════════════════════════════
# Terrain shaping operations
# ═══════════════════════════════════════════════════════════════════════════

def apply_radial_falloff(height: np.ndarray, strength: float = 0.0,
                         mode: str = "island") -> np.ndarray:
    """Fade edges toward 0 (island) or toward center (crater)."""
    h, w = height.shape
    cy, cx = h / 2, w / 2
    y, x = np.ogrid[:h, :w]
    dist = np.sqrt(((x - cx) / (w / 2)) ** 2 + ((y - cy) / (h / 2)) ** 2)
    if mode == "island":
        falloff = np.clip(1.0 - dist ** 2, 0, 1)
    elif mode == "crater":
        falloff = np.clip(dist ** 2, 0, 1)
    else:
        return height
    return height * (1.0 - strength) + height * falloff * strength


def _periodic_gradient(h: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Gradient with periodic (wrapping) boundary conditions — preserves tiling."""
    gx = np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)
    gy = np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)
    return gx * 0.5, gy * 0.5


def apply_erosion(height: np.ndarray, iterations: int = 100,
                  erosion_rate: float = 0.01, tileable: bool = True) -> np.ndarray:
    """Thermal erosion — smooth steep slopes. Uses periodic boundaries when tileable."""
    h = height.copy()
    for _ in range(iterations):
        if tileable:
            gx, gy = _periodic_gradient(h)
        else:
            gy, gx = np.gradient(h)
        slope = np.sqrt(gx ** 2 + gy ** 2)
        h -= slope * erosion_rate
    return h


def apply_plateau(height: np.ndarray, levels: int = 4) -> np.ndarray:
    """Quantize into terraced plateaus."""
    normalized = (height - height.min()) / (height.max() - height.min() + 1e-9)
    stepped = np.round(normalized * levels) / levels
    return stepped * (height.max() - height.min()) + height.min()


def apply_valley(height: np.ndarray, depth: float = 0.3) -> np.ndarray:
    """Carve valleys — lower the mid-range elevations."""
    normalized = (height - height.min()) / (height.max() - height.min() + 1e-9)
    valley = 1.0 - np.abs(normalized - 0.5) * 2.0
    return height - valley * depth * (height.max() - height.min())


def normalize_01(height: np.ndarray) -> np.ndarray:
    """Normalize to [0, 1] range."""
    h_min = height.min()
    h_max = height.max()
    if h_max - h_min < 1e-9:
        return np.zeros_like(height)
    return (height - h_min) / (h_max - h_min)


def to_png(height_01: np.ndarray, path: Path) -> None:
    """Save a [0,1] heightmap as an 8-bit grayscale PNG (R=G=B=height)."""
    arr = np.clip(height_01 * 255.0, 0, 255).astype(np.uint8)
    rgb = np.stack([arr, arr, arr], axis=-1)
    Image.fromarray(rgb, mode="RGB").save(path)
    print(f"  Saved: {path}  ({arr.shape[1]}x{arr.shape[0]}, R-channel heightmap)")


def wrap_edges(height_01: np.ndarray) -> np.ndarray:
    """Add a duplicate of the first row/column at the end, producing a (N+1)x(N+1)
    heightmap from an NxN one.

    This follows the standard 2^n+1 convention used by Unity, Godot, and most
    terrain engines: heightmap pixels represent vertices, and the last vertex
    on each edge is shared with the neighboring tile. The +1 row/column is the
    wrapped edge — identical to the first — so tiled terrain has no gaps or
    overlaps.

    For our client's texture-based approach this is NOT needed (fract() wrapping
    handles it), but it's useful for exporting to vertex-grid terrain engines.
    """
    h, w = height_01.shape
    out = np.empty((h + 1, w + 1), dtype=height_01.dtype)
    out[:h, :w] = height_01
    out[:h, w] = height_01[:, 0]    # right edge = left edge
    out[h, :w] = height_01[0, :]    # bottom edge = top edge
    out[h, w] = height_01[0, 0]     # corner
    return out


# ═══════════════════════════════════════════════════════════════════════════
# Presets
# ═══════════════════════════════════════════════════════════════════════════

PRESETS = {
    "desert": {
        "algorithm": "ridged",
        "octaves": 7,
        "res": 4,
        "persistence": 0.45,
        "lacunarity": 2,
        "erosion_iterations": 200,
        "erosion_rate": 0.008,
        "falloff_strength": 0.0,
        "falloff_mode": "island",
        "description": "Sand dunes with ridged noise and light erosion (tileable)",
    },
    "mountains": {
        "algorithm": "ridged",
        "octaves": 8,
        "res": 2,
        "persistence": 0.55,
        "lacunarity": 2,
        "erosion_iterations": 300,
        "erosion_rate": 0.012,
        "falloff_strength": 0.0,
        "falloff_mode": "island",
        "description": "Sharp mountain ridges with heavy erosion (tileable)",
    },
    "rolling": {
        "algorithm": "fbm",
        "octaves": 5,
        "res": 4,
        "persistence": 0.5,
        "lacunarity": 2,
        "erosion_iterations": 100,
        "erosion_rate": 0.005,
        "falloff_strength": 0.0,
        "falloff_mode": "island",
        "description": "Gentle rolling hills (tileable)",
    },
    "islands": {
        "algorithm": "fbm",
        "octaves": 6,
        "res": 4,
        "persistence": 0.5,
        "lacunarity": 2,
        "erosion_iterations": 50,
        "erosion_rate": 0.005,
        "falloff_strength": 0.6,
        "falloff_mode": "island",
        "description": "Scattered islands with strong edge falloff (NOT tileable — falloff breaks tiling)",
    },
    "canyons": {
        "algorithm": "fbm",
        "octaves": 7,
        "res": 4,
        "persistence": 0.6,
        "lacunarity": 2,
        "erosion_iterations": 500,
        "erosion_rate": 0.015,
        "falloff_strength": 0.0,
        "falloff_mode": "island",
        "description": "Deeply eroded canyons (tileable)",
    },
    "plateau": {
        "algorithm": "fbm",
        "octaves": 6,
        "res": 4,
        "persistence": 0.5,
        "lacunarity": 2,
        "erosion_iterations": 50,
        "erosion_rate": 0.003,
        "falloff_strength": 0.0,
        "falloff_mode": "island",
        "description": "Terraced plateaus (tileable)",
    },
}


def _validate_tiling_constraints(size: int, res: int, octaves: int,
                                  lacunarity: int, tileable: bool) -> None:
    """Check that size/res/lacunarity/octaves are compatible for tileable noise."""
    if not tileable:
        return
    divisor = res * (lacunarity ** (octaves - 1))
    if size % divisor != 0:
        raise ValueError(
            f"Tileable noise requires size ({size}) to be divisible by "
            f"res * lacunarity^(octaves-1) = {res} * {lacunarity}^{octaves-1} = {divisor}. "
            f"Try size={((size // divisor) + 1) * divisor} or adjust res/octaves/lacunarity."
        )


def generate_heightmap(args) -> np.ndarray:
    """Generate a raw [0,1] heightmap based on args."""
    size = args.size
    seed = args.seed
    tileable = not args.no_tile

    if args.preset:
        cfg = PRESETS[args.preset]
        algorithm = cfg["algorithm"]
        octaves = cfg["octaves"]
        res = cfg["res"]
        persistence = cfg["persistence"]
        lacunarity = cfg["lacunarity"]
        erosion_iters = cfg["erosion_iterations"]
        erosion_rate = cfg["erosion_rate"]
        falloff_strength = cfg["falloff_strength"]
        falloff_mode = cfg["falloff_mode"]
        # Presets with falloff > 0 break tiling
        if falloff_strength > 0:
            tileable = False
        print(f"  Preset: {args.preset} — {cfg['description']}")
    else:
        algorithm = args.algorithm
        octaves = args.octaves
        res = args.res
        persistence = args.persistence
        lacunarity = args.lacunarity
        erosion_iters = args.erosion
        erosion_rate = args.erosion_rate
        falloff_strength = args.falloff
        falloff_mode = args.falloff_mode

    # Lacunarity must be integer for tileable noise
    lacunarity_int = int(lacunarity)
    if lacunarity != lacunarity_int and tileable:
        print(f"  WARNING: lacunarity {lacunarity} is not integer — rounding to {lacunarity_int} for tiling")
        lacunarity = lacunarity_int

    _validate_tiling_constraints(size, res, octaves, lacunarity, tileable)

    print(f"  Algorithm: {algorithm}, size: {size}x{size}, seed: {seed}")
    print(f"  Octaves: {octaves}, res: {res}, persistence: {persistence}, lacunarity: {lacunarity}")
    print(f"  Tileable: {tileable}")

    if tileable:
        if algorithm == "fbm":
            height = fbm_tileable(size, res, octaves, persistence, lacunarity, seed)
        elif algorithm == "ridged":
            height = ridged_tileable(size, res, octaves, persistence, lacunarity, seed)
        else:
            raise ValueError(f"Unknown algorithm: {algorithm}")
    else:
        # Non-tileable fallback (simpler, no constraints)
        if algorithm == "fbm":
            _set_seed(seed)
            height = generate_fractal_noise_2d(
                (size, size), (res, res),
                octaves=octaves, persistence=persistence,
                lacunarity=lacunarity, tileable=(False, False),
            )
        elif algorithm == "ridged":
            total = np.zeros((size, size), dtype=np.float64)
            amplitude = 1.0
            max_amp = 0.0
            for o in range(octaves):
                _set_seed(seed + o * 1013)
                octave_res = res * (lacunarity ** o)
                noise = generate_perlin_noise_2d(
                    (size, size), (octave_res, octave_res),
                    tileable=(False, False),
                )
                ridged = (1.0 - np.abs(noise)) ** 2
                total += ridged * amplitude
                max_amp += amplitude
                amplitude *= persistence
            height = total / max_amp
        else:
            raise ValueError(f"Unknown algorithm: {algorithm}")

    # Erosion (with periodic boundaries if tileable)
    if erosion_iters > 0:
        print(f"  Erosion: {erosion_iters} iterations (rate={erosion_rate})")
        height = apply_erosion(height, iterations=erosion_iters,
                               erosion_rate=erosion_rate, tileable=tileable)

    # Plateau terracing
    if args.plateau_levels > 0:
        print(f"  Plateau: {args.plateau_levels} levels")
        height = apply_plateau(height, levels=args.plateau_levels)

    # Valley carving
    if args.valley_depth > 0:
        print(f"  Valley: depth={args.valley_depth}")
        height = apply_valley(height, depth=args.valley_depth)

    # Radial falloff (breaks tiling — warn)
    if falloff_strength > 0:
        if tileable:
            print(f"  WARNING: Radial falloff breaks seamless tiling!")
        print(f"  Falloff: strength={falloff_strength}, mode={falloff_mode}")
        height = apply_radial_falloff(height, strength=falloff_strength,
                                      mode=falloff_mode)

    # Normalize to [0,1]
    height_01 = normalize_01(height)

    # Apply height curve (contrast)
    if args.height_curve != 1.0:
        print(f"  Height curve: gamma={args.height_curve}")
        height_01 = height_01 ** args.height_curve

    return height_01


# ═══════════════════════════════════════════════════════════════════════════
# CLI commands
# ═══════════════════════════════════════════════════════════════════════════

def cmd_generate(args):
    print("=== Heightmap Generator ===")
    height = generate_heightmap(args)

    # Optionally wrap edges for 2^n+1 vertex-grid convention (Unity/Godot export)
    if args.vertex_grid:
        print(f"  Vertex grid: wrapping edges ({height.shape[0]} -> {height.shape[0]+1})")
        height = wrap_edges(height)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    to_png(height, out)

    # Stats
    print(f"  Height range: [{height.min():.4f}, {height.max():.4f}]")
    print(f"  In-world: 0 to {height.max() * CLIENT_HEIGHT_SCALE:.1f}m "
          f"(scale={CLIENT_HEIGHT_SCALE}, world={CLIENT_WORLD_SCALE}m)")
    print("Done.")


def cmd_info(args):
    """Print info about an existing heightmap PNG."""
    path = Path(args.path)
    img = Image.open(path)
    arr = np.array(img)
    print(f"=== Heightmap Info: {path.name} ===")
    print(f"  Size: {img.size[0]}x{img.size[1]}")
    print(f"  Mode: {img.mode}")

    # Detect bit depth — 16-bit (I;16) images get converted to 8-bit by the
    # browser canvas, so we report both the raw and effective 8-bit values.
    is_16bit = img.mode in ("I;16", "I", "F") or arr.dtype == np.uint16
    if is_16bit:
        raw = arr if arr.ndim == 2 else arr[..., 0]
        r_8bit = (raw / 256).astype(np.uint8)  # what the browser canvas sees
        print(f"  Bit depth: 16-bit (browser canvas converts to 8-bit)")
        print(f"  Raw range: [{raw.min()}, {raw.max()}]")
        print(f"  Effective 8-bit range: [{r_8bit.min()}, {r_8bit.max()}]")
        print(f"  Effective mean: {r_8bit.mean():.1f}, std: {r_8bit.std():.1f}")
        normalized = r_8bit / CLIENT_DIVISOR
    else:
        r = arr[..., 0] if arr.ndim == 3 else arr
        print(f"  Channels: {arr.shape[2] if arr.ndim == 3 else 1}")
        print(f"  R-channel range: [{r.min()}, {r.max()}]")
        print(f"  R-channel mean: {r.mean():.1f}, std: {r.std():.1f}")
        normalized = r / CLIENT_DIVISOR

    print(f"  Normalized: [{normalized.min():.4f}, {normalized.max():.4f}]")
    print(f"  World height: 0 to {normalized.max() * CLIENT_HEIGHT_SCALE:.1f}m")
    print(f"  World footprint: {CLIENT_WORLD_SCALE}m x {CLIENT_WORLD_SCALE}m")


def cmd_preview(args):
    """Generate a colored preview image from a heightmap."""
    path = Path(args.path)
    img = Image.open(path)
    arr = np.array(img)
    r = arr[..., 0] if arr.ndim == 3 else arr
    h = r.astype(np.float64) / 255.0

    # Compute normals for shading
    gy, gx = np.gradient(h)
    normals = np.stack([-gx, -gy, np.ones_like(h)], axis=-1)
    norms = np.linalg.norm(normals, axis=-1, keepdims=True)
    normals = normals / (norms + 1e-9)
    light = np.array([0.5, 0.7, 0.5])
    light = light / np.linalg.norm(light)
    shade = np.clip(normals @ light, 0, 1)

    # Color ramp: blue (water) -> green (low) -> brown (mid) -> white (peak)
    colors = np.array([
        [0.1, 0.2, 0.5],    # deep water
        [0.2, 0.4, 0.7],    # shallow water
        [0.3, 0.5, 0.2],    # grass
        [0.5, 0.4, 0.2],    # dirt
        [0.6, 0.55, 0.5],   # rock
        [0.9, 0.9, 0.9],    # snow
    ], dtype=np.float64)
    stops = np.array([0.0, 0.15, 0.3, 0.5, 0.75, 1.0])

    colored = np.zeros((h.shape[0], h.shape[1], 3), dtype=np.float64)
    for i in range(len(stops) - 1):
        mask = (h >= stops[i]) & (h <= stops[i + 1])
        t = ((h[mask] - stops[i]) / (stops[i + 1] - stops[i] + 1e-9))[:, None]
        colored[mask] = colors[i] * (1 - t) + colors[i + 1] * t

    colored *= (0.4 + 0.6 * shade[..., None])
    colored = np.clip(colored * 255, 0, 255).astype(np.uint8)

    out = Path(args.output) if args.output else path.with_suffix(".preview.png")
    Image.fromarray(colored).save(out)
    print(f"Preview saved: {out}")


def cmd_list_presets(args):
    print("Available presets:")
    for name, cfg in PRESETS.items():
        tileable = "tileable" if cfg["falloff_strength"] == 0 else "NOT tileable"
        print(f"  {name:12s} — {cfg['description']}")
        print(f"               algo={cfg['algorithm']}, octaves={cfg['octaves']}, "
              f"res={cfg['res']}, erosion={cfg['erosion_iterations']}, {tileable}")


def cmd_verify(args):
    """Verify that a heightmap tiles seamlessly by comparing edge differences
    to interior pixel-to-pixel differences. A seamless heightmap has edge
    diffs similar to interior step diffs (both are just adjacent pixels)."""
    path = Path(args.path)
    img = Image.open(path)
    arr = np.array(img)
    r = arr[..., 0] if arr.ndim == 3 else arr
    h = r.astype(np.float64) / 255.0

    # Edge diffs (what the client's fract() wrap sees)
    top = h[0, :]
    bottom = h[-1, :]
    left = h[:, 0]
    right = h[:, -1]

    max_diff_tb = np.max(np.abs(top - bottom))
    max_diff_lr = np.max(np.abs(left - right))
    mean_diff_tb = np.mean(np.abs(top - bottom))
    mean_diff_lr = np.mean(np.abs(left - right))

    # Interior pixel-to-pixel diffs (baseline for comparison)
    interior_h = np.abs(h[:, :-1] - h[:, 1:])  # horizontal steps
    interior_v = np.abs(h[:-1, :] - h[1:, :])  # vertical steps
    interior_max = max(interior_h.max(), interior_v.max())
    interior_mean = max(interior_h.mean(), interior_v.mean())

    print(f"=== Tiling Verification: {path.name} ===")
    print(f"  Edge diffs (seam):")
    print(f"    Top↔Bottom:  max={max_diff_tb:.6f}, mean={mean_diff_tb:.6f}")
    print(f"    Left↔Right:  max={max_diff_lr:.6f}, mean={mean_diff_lr:.6f}")
    print(f"  Interior pixel steps (baseline):")
    print(f"    max={interior_max:.6f}, mean={interior_mean:.6f}")

    # Seamless if edge max diff is not significantly worse than interior max
    ratio_tb = max_diff_tb / (interior_max + 1e-9)
    ratio_lr = max_diff_lr / (interior_max + 1e-9)
    print(f"  Edge/interior ratio:  TB={ratio_tb:.2f}x, LR={ratio_lr:.2f}x")

    # Seamless if edge diff is within 2x of interior max (allows for normal variation)
    seamless = ratio_tb < 2.0 and ratio_lr < 2.0
    if seamless:
        print(f"  ✓ SEAMLESS (edge diffs within 2x of interior pixel steps)")
    else:
        print(f"  ✗ NOT SEAMLESS (edge diffs significantly exceed interior steps)")
        print(f"    The client's fract() wrapping will show a visible seam.")
        if ratio_tb >= 2.0:
            worst_col = np.argmax(np.abs(top - bottom))
            print(f"    Worst top↔bottom at col {worst_col}: {top[worst_col]:.4f} vs {bottom[worst_col]:.4f}")
        if ratio_lr >= 2.0:
            worst_row = np.argmax(np.abs(left - right))
            print(f"    Worst left↔right at row {worst_row}: {left[worst_row]:.4f} vs {right[worst_row]:.4f}")


# ═══════════════════════════════════════════════════════════════════════════
# Argument parsing
# ═══════════════════════════════════════════════════════════════════════════

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Heightmap generator for FPSWebTest terrain."
    )
    sub = p.add_subparsers(dest="command", required=True)

    # generate
    gen = sub.add_parser("generate", help="Generate a new heightmap PNG")
    gen.add_argument("-o", "--output", default="heightmap.png",
                     help="Output PNG path (default: heightmap.png)")
    gen.add_argument("-s", "--size", type=int, default=1024,
                     help="Heightmap resolution (square, default: 1024)")
    gen.add_argument("--seed", type=int, default=0,
                     help="Random seed (default: 0)")
    # Preset shortcut
    gen.add_argument("-p", "--preset", choices=list(PRESETS.keys()),
                     help="Use a preset configuration")
    # Algorithm
    gen.add_argument("--algorithm", choices=["fbm", "ridged"], default="fbm",
                     help="Noise algorithm (default: fbm)")
    gen.add_argument("--octaves", type=int, default=6,
                     help="Number of noise octaves (default: 6)")
    gen.add_argument("--res", type=int, default=4,
                     help="Grid cells for lowest octave — lower = larger features (default: 4). "
                          "size must be divisible by res * lacunarity^(octaves-1) for tiling")
    gen.add_argument("--persistence", type=float, default=0.5,
                     help="Amplitude decay per octave (default: 0.5)")
    gen.add_argument("--lacunarity", type=int, default=2,
                     help="Frequency growth per octave — must be integer for tiling (default: 2)")
    gen.add_argument("--no-tile", action="store_true",
                     help="Disable seamless tiling (removes size/res constraints)")
    gen.add_argument("--vertex-grid", action="store_true",
                     help="Output 2^n+1 size by duplicating first row/column at edges "
                          "(for Unity/Godot vertex-grid export). Client doesn't need this.")
    # Shaping
    gen.add_argument("--erosion", type=int, default=0,
                     help="Thermal erosion iterations (default: 0)")
    gen.add_argument("--erosion-rate", type=float, default=0.01,
                     help="Erosion strength per iteration (default: 0.01)")
    gen.add_argument("--falloff", type=float, default=0.0,
                     help="Radial edge falloff strength 0-1 (default: 0)")
    gen.add_argument("--falloff-mode", choices=["island", "crater"],
                     default="island", help="Falloff shape (default: island)")
    gen.add_argument("--plateau-levels", type=int, default=0,
                     help="Terrace quantization levels, 0=off (default: 0)")
    gen.add_argument("--valley-depth", type=float, default=0.0,
                     help="Valley carving depth 0-1 (default: 0)")
    gen.add_argument("--height-curve", type=float, default=1.0,
                     help="Gamma curve on final height, 1=linear (default: 1.0)")
    gen.set_defaults(func=cmd_generate)

    # info
    inf = sub.add_parser("info", help="Print info about an existing heightmap")
    inf.add_argument("path", help="Path to heightmap PNG")
    inf.set_defaults(func=cmd_info)

    # preview
    prv = sub.add_parser("preview", help="Generate a colored preview from a heightmap")
    prv.add_argument("path", help="Path to heightmap PNG")
    prv.add_argument("-o", "--output", default=None,
                     help="Output preview path (default: <name>.preview.png)")
    prv.set_defaults(func=cmd_preview)

    # verify
    ver = sub.add_parser("verify", help="Check if a heightmap tiles seamlessly")
    ver.add_argument("path", help="Path to heightmap PNG")
    ver.add_argument("--threshold", type=float, default=0.01,
                     help="Max edge difference for seamless (default: 0.01 = ~2.5 in 0-255)")
    ver.set_defaults(func=cmd_verify)

    # presets
    lst = sub.add_parser("presets", help="List available presets")
    lst.set_defaults(func=cmd_list_presets)

    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
