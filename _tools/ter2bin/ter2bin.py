#!/usr/bin/env python3
"""ter2bin — port Tribes 2 terrain + mission metadata into KRIBES map files.

Reads a stock T2 install's .vl2 (zip) archives:

  .ter — Torque TerrainFile v2: 1-byte version, then 256x256 uint16 LE
         heights in 11.5 fixed-point (meters = raw / 32), grid square 8m
         -> 2048m tile. Material/alpha maps trail the height block; we
         ignore them.
  .mis — TorqueScript SimGroup tree. We lift Team1Flag/Team2Flag item
         positions (flag stands) and SpawnSphere positions (spawns).

Outputs:

  maps/<name>.bin  — our heightfield: u32 LE w,h header + u8 heights.
                     Default normalizes relief to the full 0..255 byte
                     range (0..125m world height). --vscale N instead
                     maps T2 meters * N / 125 -> byte (clamped).
  maps/<name>.json — spec wrapper: ctf, bases (flag stands), spawns.

Coordinates: T2 world is centered at origin, 2048m tile; ours wraps at
TERRAIN_WORLD_SCALE = 1500m. x/z positions scale by 1500/2048. y is
advisory — our spawn picker and RoomFlags snap to the live field.

Usage:
  python _tools/ter2bin/ter2bin.py "D:/[Games]/Tribes2/GameData/base/missions.vl2" Katabatic
  python _tools/ter2bin/ter2bin.py <vl2> <MapName> [--list] [--vscale 1.0] [--size 512]
"""

import argparse
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

import numpy as np

REPO_MAPS = Path(__file__).resolve().parents[2] / "maps"
T2_TILE_M = 2048.0          # 256 squares * 8m
OUR_TILE_M = 1500.0         # TERRAIN_WORLD_SCALE
XZ_SCALE = OUR_TILE_M / T2_TILE_M
HEIGHT_SCALE_M = 125.0      # TERRAIN_HEIGHT_SCALE
GRID = 256                  # T2 heightfield side


def load_ter(vl2: zipfile.ZipFile, name: str) -> np.ndarray:
    for cand in (f"terrains/{name}.ter", f"{name}.ter"):
        try:
            raw = vl2.read(cand)
            break
        except KeyError:
            continue
    else:
        raise SystemExit(f"no terrains/{name}.ter in archive")
    if raw[0] > 7:
        raise SystemExit(f"unexpected ter version {raw[0]}")
    need = 1 + GRID * GRID * 2
    if len(raw) < need:
        raise SystemExit(f"short ter: {len(raw)} < {need}")
    return np.frombuffer(raw, "<u2", GRID * GRID, 1).reshape(GRID, GRID) / 32.0


def parse_mis(vl2: zipfile.ZipFile, name: str) -> dict:
    try:
        text = vl2.read(f"missions/{name}.mis").decode("latin1")
    except KeyError:
        raise SystemExit(f"no missions/{name}.mis in archive")

    def positions(block_pat, obj_pat):
        out = []
        for m in re.finditer(obj_pat + r"\s*\{(.*?)\};", text, re.S):
            p = re.search(r'position\s*=\s*"([^"]+)"', m.group(1))
            if p:
                out.append(tuple(float(v) for v in p.group(1).split()))
        return out

    flags = {}
    for team, our in (("Team1", "alpha"), ("Team2", "bravo")):
        pos = positions(None, rf"new Item\({team}Flag\d*\)")
        if pos:
            flags[our] = pos[0]
    spawns = positions(None, r"new SpawnSphere\([^)]*\)")
    return {"flags": flags, "spawns": spawns}


def scale_xz(p):
    return {"x": round(p[0] * XZ_SCALE, 1), "y": 0, "z": round(p[1] * XZ_SCALE, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("vl2")
    ap.add_argument("map", nargs="?", help="mission name, e.g. Katabatic")
    ap.add_argument("--list", action="store_true", help="list missions in archive")
    ap.add_argument("--vscale", type=float, default=0.0,
                    help="meters->meters factor; 0 = normalize relief to 0..255")
    ap.add_argument("--size", type=int, default=GRID, help="output grid (resampled)")
    ap.add_argument("--out", type=Path, default=REPO_MAPS)
    ap.add_argument("--name", help="output map id (default: lowercased mission name)")
    args = ap.parse_args()

    vl2 = zipfile.ZipFile(args.vl2)
    if args.list or not args.map:
        for n in sorted(vl2.namelist()):
            if n.endswith(".mis"):
                print(Path(n).stem)
        return

    name = args.name or args.map.lower()
    hm = load_ter(vl2, args.map)
    meta = parse_mis(vl2, args.map)

    if args.size != GRID:
        # bilinear resample via numpy-free grid interp
        ys = np.linspace(0, GRID - 1, args.size)
        xs = np.linspace(0, GRID - 1, args.size)
        y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
        fy, fx = (ys - y0)[:, None], (xs - x0)[None, :]
        y1, x1 = np.clip(y0 + 1, 0, GRID - 1), np.clip(x0 + 1, 0, GRID - 1)
        hm = (hm[np.ix_(y0, x0)] * (1 - fx) * (1 - fy)
              + hm[np.ix_(y0, x1)] * fx * (1 - fy)
              + hm[np.ix_(y1, x0)] * (1 - fx) * fy
              + hm[np.ix_(y1, x1)] * fx * fy)

    lo, hi = float(hm.min()), float(hm.max())
    relief = hi - lo
    if args.vscale > 0:
        data = np.clip((hm - lo) * args.vscale / HEIGHT_SCALE_M * 255.0, 0, 255)
    else:
        data = (hm - lo) / max(relief, 1e-6) * 255.0
    u8 = np.rint(data).astype(np.uint8)

    n = u8.shape[0]
    bin_path = args.out / f"{name}.bin"
    bin_path.write_bytes(struct.pack("<II", n, n) + u8.tobytes())

    spec = {
        "mode": "ctf",
        "modes": ["ctf"],
        "bots": 8,
        "botFill": 10,
        "bases": {k: scale_xz(v) for k, v in meta["flags"].items()},
        "spawns": [scale_xz(s) for s in meta["spawns"]],
        "terrain": f"{name}.bin",
        "_t2": f"ported from Tribes 2 '{args.map}' — relief {relief:.0f}m -> 125m",
    }
    json_path = args.out / f"{name}.json"
    json_path.write_text(json.dumps(spec, indent=2) + "\n")

    print(f"{args.map}: raw {lo:.0f}..{hi:.0f}m ({relief:.0f}m relief)")
    print(f"  -> {bin_path.name} {n}x{n}, bytes {u8.min()}..{u8.max()}")
    print(f"  bases: { {k: spec['bases'][k] for k in spec['bases']} }")
    print(f"  spawns: {len(spec['spawns'])}  ->  {json_path.name}")


if __name__ == "__main__":
    main()
