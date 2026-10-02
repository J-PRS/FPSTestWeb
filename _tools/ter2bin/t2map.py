#!/usr/bin/env python3
"""t2map — full-fidelity Tribes 2 map extraction for KRIBES.

Pulls everything needed to render a stock T2 mission out of the game's
own .vl2 archives (plain zips):

  .ter  -> terrain heights (256^2 u16, 11.5 fixed point meters/32)
           + materialMap (u8 material index per 8m square)
           + 8 length-prefixed material names
           + alphaMap u8[256^2] per used material (blend weights, ~sum 255)

  textures.vl2 -> 'textures/terrain/<World>.<Mat>.png' albedo tiles,
                  one 256^2 texture tiled per 8m square
  Sky block in .mis -> materialList .dml -> 6 face texture names ->
                  'textures/<face>.png'

Outputs under maps/t2/<name>/:
  terrain.bin    - our heightfield format (u32 w,h + u8 grid)
  albedo.png     - baked blended terrain texture (alphaMap-weighted)
  sky/*.png      - skybox faces in dml order (f r b l t d + emap/clouds)
  <name>.json    - map spec (bases/spawns scaled 2048m -> 1500m world)

Local playtest assets only — extracted copyrighted content, gitignored.

Usage:
  python _tools/ter2bin/t2map.py Escalade Equinox Invictus
  python _tools/ter2bin/t2map.py --vl2 Classic_maps_v1.vl2 Surreal
"""

import argparse
import io
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
# Porter config remembers where the T2 install lives so future sessions
# don't rediscover it — `_tools/ter2bin/t2porter.json` {"t2_base": ...}.
# Resolution order: --base flag > T2_BASE env > config > this default.
CONFIG = Path(__file__).resolve().parent / "t2porter.json"
T2_BASE = Path(r"D:\[Games]\Tribes2\GameData\base")


def load_base() -> Path:
    cfg_base = None
    try:
        cfg_base = json.loads(CONFIG.read_text()).get("t2_base")
    except Exception:
        pass
    return Path(__import__("os").environ.get("T2_BASE") or cfg_base or T2_BASE)


def save_base(base: Path) -> None:
    CONFIG.write_text(json.dumps({"t2_base": str(base)}, indent=2) + "\n")


OUT = REPO / "maps" / "t2"

GRID = 256
T2_TILE_M = 2048.0
OUR_TILE_M = 1500.0
XZ_SCALE = OUR_TILE_M / T2_TILE_M
HEIGHT_SCALE_M = 125.0
ALBEDO_RES = 2048          # 8 px per 8m square


def parse_ter(name: str):
    raw = vl2_read(f"terrains/{name}.ter")
    hm = np.frombuffer(raw, "<u2", GRID * GRID, 1).reshape(GRID, GRID) / 32.0
    off = 1 + GRID * GRID * 2
    matmap = np.frombuffer(raw, "u1", GRID * GRID, off).reshape(GRID, GRID)
    p = off + GRID * GRID
    names = []
    for _ in range(8):
        ln = raw[p]
        names.append(raw[p + 1 : p + 1 + ln].decode("latin1"))
        p += 1 + ln
    used = [i for i, n in enumerate(names) if n]
    alpha = np.zeros((GRID, GRID, len(used)), dtype=np.uint8)
    for k in range(len(used)):
        alpha[:, :, k] = np.frombuffer(raw, "u1", GRID * GRID, p + k * GRID * GRID).reshape(GRID, GRID)
    return hm, matmap, names, used, alpha


VL2S = {}  # name -> zipfile, every archive in GameData/base

_NAMELIST = {}  # lowercased entry -> real entry, across all vl2s

def vl2_read(path: str):
    real = _NAMELIST.get(path.lower())
    if real:
        return VL2S[real[0]].read(real[1])
    for z in VL2S.values():
        try:
            return z.read(path)
        except KeyError:
            continue
    raise KeyError(path)


def load_tex(mat_name: str) -> np.ndarray:
    # material names are sometimes prefixed: 'terrain.LushWorld.X'
    short = mat_name.split(".", 1)[1] if mat_name.startswith("terrain.") else mat_name
    import io
    for cand in (f"textures/terrain/{short}.png", f"textures/terrain/{mat_name}.png",
                 f"textures/{mat_name}.png"):
        try:
            img = Image.open(io.BytesIO(vl2_read(cand))).convert("RGB")
            return np.asarray(img, dtype=np.float32)
        except KeyError:
            continue
    raise SystemExit(f"no texture for material '{mat_name}'")


# Texture repeat cadence in output pixels — T2 tiles material textures in
# world space (continuous across grid cells), roughly one repeat per ~30m.
# Smaller = finer repeats; the textures are 256px, so 32 keeps ~8px/m.
TILE_PX = 32


def half_shift(a):
    """T2's terrain square is centered on the world origin, but our
    heightmap UV maps frac(world/1500) — a half-tile phase difference.
    Rolling every grid-derived export by half its width makes
    texel (x,z) land on T2 coordinate (u,v) instead of (u+1024,v+1024).
    ±half is identical modulo the wrap."""
    return np.roll(np.roll(a, a.shape[0] // 2, axis=0), a.shape[1] // 2, axis=1)


def bake_albedo(matmap, names, used, alpha, res=ALBEDO_RES):
    """alphaMap weights blend continuously-tiled material textures — T2's
    real blend, not per-cell stamping. Weights are per-8m-cell, so
    upsampling alone leaves visible cell-boundary seams; feather them
    over ~1.5 cells with a small gaussian, the way T2's vertex-smoothed
    blend reads on the ground."""
    from PIL import ImageFilter
    texs = [load_tex(names[i]) for i in used]
    out = np.zeros((res, res, 3), dtype=np.float32)
    feather = max(2, round(res / GRID * 1.5))
    ws = [np.asarray(
            Image.fromarray(alpha[:, :, k])
                 .resize((res, res), Image.BICUBIC)
                 .filter(ImageFilter.GaussianBlur(feather)),
            dtype=np.float32) / 255.0 for k in range(len(used))]
    wsum = np.clip(sum(ws), 1e-6, None)
    gy, gx = np.mgrid[0:res, 0:res]
    # Continuous world-space tiling: texel phase carries across cells.
    # Pre-downsample each texture to TILE_PX (box filter — mip-correct)
    # rather than aliasing a nearest-neighbor skip through 256px.
    ty, tx = gy % TILE_PX, gx % TILE_PX
    for k, tex in enumerate(texs):
        small = np.asarray(
            Image.fromarray(tex.astype(np.uint8)).resize((TILE_PX, TILE_PX), Image.BOX),
            dtype=np.float32)
        out += small[ty, tx] * (ws[k] / wsum)[:, :, None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def tex_blob(mat_name: str):
    """Raw PNG bytes for a material's 256px tile — shader-blend exports."""
    short = mat_name.split(".", 1)[1] if mat_name.startswith("terrain.") else mat_name
    for cand in (f"textures/terrain/{short}.png", f"textures/terrain/{mat_name}.png",
                 f"textures/{mat_name}.png"):
        try:
            return vl2_read(cand)
        except KeyError:
            continue
    raise SystemExit(f"no texture for material '{mat_name}'")


def export_mats(dest: Path, names, used, alpha, matmap):
    """Full-fidelity blend inputs for the terrain shader: the client tiles
    each 256px material per 8m cell and blends by the alpha weights —
    effectively infinite detail vs the baked albedo, which stays as the
    distance/base tint. mats.json is the manifest the client fetches."""
    tdir = dest / "tiles"
    tdir.mkdir(parents=True, exist_ok=True)
    tiles = []
    for k, i in enumerate(used):
        (tdir / f"m{k}.png").write_bytes(tex_blob(names[i]))
        tiles.append(f"tiles/m{k}.png")
    (dest / "matmap.bin").write_bytes(half_shift(matmap).astype(np.uint8).tobytes())
    (dest / "alphas.bin").write_bytes(half_shift(alpha).tobytes())
    manifest = {
        "grid": GRID,
        "count": len(used),
        "tiles": tiles,
        "alphas": "alphas.bin",
        "matmap": "matmap.bin",
        # matmap cells index the 8-slot name table; tiles/alphas index the
        # used[] order — map between them for the matmap fallback path.
        "matToLayer": [used.index(i) if i in used else -1 for i in range(8)],
        "tileMeters": round(T2_TILE_M * XZ_SCALE / GRID, 3),
    }
    (dest / "mats.json").write_text(json.dumps(manifest))


def extract_sky(mis_text, dest: Path):
    m = re.search(r'new Sky\(.*?\{(.*?)\};', mis_text, re.S)
    if not m:
        return []
    ml = re.search(r'materialList\s*=\s*"([^"]+)"', m.group(1))
    if not ml:
        return []
    try:
        dml = vl2_read(f"textures/{ml.group(1)}").decode("latin1").split()
    except KeyError:
        return []
    dest.mkdir(parents=True, exist_ok=True)
    raw_faces = []
    for face in dml:
        for ext in (".png", ".jpg", ".bmp"):
            try:
                raw_faces.append((face, vl2_read(f"textures/{face}{ext}")))
                break
            except KeyError:
                continue
    # dml order is front,right,back,left,top,down (+ env/cloud extras we
    # skip). Torque axes (x=east, y=north, z=up) map to three.js cube
    # order px=r, nx=l, py=top, ny=down, pz=back, nz=front.
    if len(raw_faces) < 6:
        return []
    # Cube faces must share one resolution in GL — T2 ships 4x4
    # placeholders for the never-seen down face, which corrupts the
    # cubemap upload. Decode and resize everything up to the max.
    imgs = []
    for face, blob in raw_faces[:6]:
        try:
            imgs.append((face, Image.open(io.BytesIO(blob)).convert("RGB")))
        except Exception:
            return []
    side = max(im.width for im in (i[1] for i in imgs))
    faces = {}
    for (face, im), cube in zip(imgs, ("nz", "px", "pz", "nx", "py", "ny")):
        if im.width != side:
            im = im.resize((side, side), Image.NEAREST)
        # T2's right face is stored upside-down vs the GL cubemap
        # convention — unflipped, its dark below-horizon half renders as
        # a wedge across the upper sky.
        if cube == "px":
            im = im.transpose(Image.FLIP_TOP_BOTTOM)
        im.save(dest / f"{cube}.png")
        faces[cube] = face
    return faces


def parse_mis(name: str):
    try:
        text = vl2_read(f"missions/{name}.mis").decode("latin1")
    except KeyError:
        raise SystemExit(f"no missions/{name}.mis")
    def pos(pat):
        out = []
        for m in re.finditer(pat + r"\s*\{(.*?)\};", text, re.S):
            p = re.search(r'position\s*=\s*"([^"]+)"', m.group(1))
            if p:
                out.append(tuple(float(v) for v in p.group(1).split()))
        return out

    def subtree_end(start):
        depth = 0
        for m in re.finditer(r"[{}]", text[start:]):
            depth += 1 if m.group(0) == "{" else -1
            if depth == 0:
                return start + m.start()
        return len(text)

    # ObserverDropPoints SpawnSpheres are spectator cams, not player
    # spawns — find that group's extent and drop anything inside.
    obs = re.search(r"new SimGroup\(ObserverDropPoints\)", text)
    obs_range = (obs.start(), subtree_end(obs.end())) if obs else None

    def in_obs(i):
        return obs_range and obs_range[0] < i < obs_range[1]

    def spawns():
        # SpawnSpheres are weighted VOLUMES — keep radius + sphereWeight
        # or every spawn lands on the sphere center. team_of attributes
        # each sphere to the SimGroup(TeamN) that contains it.
        out = []
        for m in re.finditer(r"new SpawnSphere\([^)]*\)\s*\{(.*?)\};", text, re.S):
            if in_obs(m.start()):
                continue
            body = m.group(1)
            p = re.search(r'position\s*=\s*"([^"]+)"', body)
            if p:
                r = re.search(r'radius\s*=\s*"([^"]+)"', body)
                w = re.search(r'sphereWeight\s*=\s*"([^"]+)"', body)
                out.append({
                    "pos": tuple(float(v) for v in p.group(1).split()),
                    "r": float(r.group(1)) if r else 0.0,
                    "w": float(w.group(1)) if w else 100.0,
                    "team": team_of(m.start()),
                })
        return out
    # Team subtrees — objects inside a SimGroup(TeamN) belong to that
    # team. Naming isn't stable across maps (Team1/Team2 on Slapdash,
    # team0/Team1 on SunDried), so whichever TWO TeamN groups exist get
    # alpha/bravo in file order; extra TeamN groups fold into the first
    # two rather than inventing more sides.
    team_groups = [(tm.start(), subtree_end(tm.end()))
                   for tm in re.finditer(r"new SimGroup\((Team\d|team\d)\)", text)]
    team_ranges = {}
    for i, rng in enumerate(team_groups):
        key = "alpha" if i == 0 else "bravo"
        if key not in team_ranges:
            team_ranges[key] = rng

    def team_of(i):
        for k, (a, b) in team_ranges.items():
            if a < i < b:
                return k
        return None

    def pos_of(body):
        p = re.search(r'position\s*=\s*"([^"]+)"', body)
        return tuple(float(v) for v in p.group(1).split()) if p else None

    def parent_group_name(i):
        # Innermost enclosing 'new SimGroup(<name>)' — for objects whose
        # team shows up in the group name (base0/base1, TeamN) rather
        # than a TeamN subtree.
        name = None
        depth = 0
        for m in re.finditer(r"new SimGroup\(([^)]*)\)|[{}]", text[:i]):
            g = m.group(0)
            if g == "{":
                depth += 1
            elif g == "}":
                depth -= 1
                if depth <= 0:
                    name = None
            else:
                name = m.group(1)
                depth += 1
        return name

    def group_team(i):
        for nm in (parent_group_name(i), ""):
            if nm:
                digits = re.search(r"(?:team|base)(\d)", nm, re.I)
                if digits:
                    return "alpha" if digits.group(1) in ("0", "1") else "bravo"
        return None

    flags = {}
    stands = {}
    # Flag items: 'new Item(){ dataBlock="Flag" }' or Katabatic-style
    # 'new Item(Team1Flag1)' — parens optional (SunDried uses a bare one).
    # ExteriorFlagStand StaticShapes anchor each team's stand and cover
    # maps whose flag item is missing/ambiguous. Case-insensitive —
    # Surreal uses "FLAG".
    for m in re.finditer(r"new (Item|StaticShape)(?:\(([^)]*)\))?\s*\{(.*?)\};", text, re.S):
        kind, name, body = m.group(1), m.group(2) or "", m.group(3)
        is_flag = re.search(r'dataBlock\s*=\s*"flag"', body, re.I) or "flag" in name.lower()
        is_stand = re.search(r'dataBlock\s*=\s*"ExteriorFlagStand"', body, re.I)
        if not (is_flag or is_stand):
            continue
        p = pos_of(body)
        if not p:
            continue
        our = team_of(m.start()) or group_team(m.start()) or ("alpha" if "1" in name else "bravo")
        (flags if is_flag else stands).setdefault(our, p)
    # A team with a stand but no flag item still caps at its stand.
    for our, p in stands.items():
        flags.setdefault(our, p)

    # Flag-less missions (CnH/FFA variants): fabricate bases at the two
    # most-separated player spawn spheres — playtest anchors, not real
    # flag stands.
    all_sp = spawns()
    for our in ("alpha", "bravo"):
        if our in flags:
            continue
        pts = [s["pos"] for s in all_sp]
        if len(pts) < 2 or (max(abs(a[0]-b[0])+abs(a[1]-b[1]) for a in pts for b in pts) < 50):
            # co-located spawns (CnH pads) — spread anchors over every
            # positioned object in the Teams subtree instead
            tm = re.search(r"new SimGroup\(Teams\)", text)
            if tm:
                pts = [tuple(float(v) for v in p.group(1).split())
                       for p in re.finditer(r'position\s*=\s*"([^"]+)"',
                                            text[tm.start():subtree_end(tm.end())])]
        if len(pts) >= 2:
            if our == "alpha":
                pair = max(((a, b) for a in pts for b in pts),
                           key=lambda ab: (ab[0][0]-ab[1][0])**2 + (ab[0][1]-ab[1][1])**2)
                flags["alpha"], flags["bravo"] = pair
            continue
        flags[our] = (250.0 if our == "alpha" else -250.0, 0.0, 0.0)
    interiors = []
    for m in re.finditer(r"new InteriorInstance\(([^)]*)\)\s*\{(.*?)\};", text, re.S):
        body = m.group(2)
        p = re.search(r'position\s*=\s*"([^"]+)"', body)
        f = re.search(r'(?:interiorFile|fileName)\s*=\s*"([^"]+)"', body)
        r = re.search(r'rotation\s*=\s*"([^"]+)"', body)
        s = re.search(r'scale\s*=\s*"([^"]+)"', body)
        if p:
            interiors.append({
                "file": f.group(1) if f else "?",
                "pos": [float(v) for v in p.group(1).split()],
                "rot": [float(v) for v in r.group(1).split()] if r else [0,0,0,0],
                "scale": [float(v) for v in s.group(1).split()] if s else [1,1,1],
            })
    return text, flags, all_sp, interiors


def sxz(p):
    return {"x": round(p[0] * XZ_SCALE, 1), "y": 0, "z": round(p[1] * XZ_SCALE, 1)}


def ssphere(s):
    out = sxz(s["pos"])
    if s["r"] > 0:
        out["r"] = round(s["r"] * XZ_SCALE, 1)
    if s["w"] != 100.0:
        out["w"] = s["w"]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("maps", nargs="+")
    ap.add_argument("--vl2", default="missions.vl2")
    ap.add_argument("--base", type=Path, default=None,
                    help="T2 GameData/base dir — remembered in t2porter.json once used")
    ap.add_argument("--vscale", type=float, default=0.0)
    ap.add_argument("--res", type=int, default=ALBEDO_RES)
    args = ap.parse_args()

    args.base = args.base or load_base()
    if not (args.base / args.vl2).exists():
        raise SystemExit(f"no {args.vl2} under {args.base} — pass --base or set T2_BASE")
    save_base(args.base)  # keep the location remembered for next time

    mis_vl2 = zipfile.ZipFile(args.base / args.vl2)
    VL2S[args.vl2] = mis_vl2
    for v in (args.base).glob("*.vl2"):
        VL2S.setdefault(v.name, zipfile.ZipFile(v))
    for v in (args.base / "z_mappacks").glob("*.vl2"):
        VL2S.setdefault(f"mp/{v.name}", zipfile.ZipFile(v))
    for k, z in VL2S.items():
        for n in z.namelist():
            _NAMELIST[n.lower()] = (k, n)

    for mapname in args.maps:
        hm, matmap, names, used, alpha = parse_ter(mapname)
        mis_text, flags, spawns, interiors = parse_mis(mapname)
        key = mapname.lower()
        dest = OUT / key
        dest.mkdir(parents=True, exist_ok=True)

        lo, hi = float(hm.min()), float(hm.max())
        relief = hi - lo
        if args.vscale > 0:
            u8 = np.clip((hm - lo) * args.vscale / HEIGHT_SCALE_M * 255.0, 0, 255)
        else:
            u8 = (hm - lo) / max(relief, 1e-6) * 255.0
        u8 = np.rint(u8).astype(np.uint8)
        (dest / "terrain.bin").write_bytes(struct.pack("<II", GRID, GRID) + half_shift(u8).tobytes())

        print(f"{mapname}: {lo:.0f}..{hi:.0f}m ({relief:.0f}m relief), mats {[names[i] for i in used]}")
        alb = np.asarray(bake_albedo(matmap, names, used, alpha, args.res))
        Image.fromarray(half_shift(alb)).save(dest / "albedo.png")
        export_mats(dest, names, used, alpha, matmap)
        faces = extract_sky(mis_text, dest / "sky")
        print(f"  albedo.png {args.res}px, sky faces: {faces}")

        # T2 (u,v,w-up) -> ours (x,y,z): x=u·XZ, z=v·XZ, y=(w-lo)·125/relief.
        # Scale is emitted in OUR axes: u,v get XZ_SCALE, w gets the
        # terrain's vertical compression, so buildings squash with the map.
        hs = HEIGHT_SCALE_M / max(relief, 1e-6)
        def sinterior(i):
            (u, v, w) = i["pos"]
            (su, sv, sw) = i.get("scale", (1, 1, 1))
            return {
                "file": i["file"],
                "pos": {"x": round(u * XZ_SCALE, 2), "y": round((w - lo) * hs, 2), "z": round(v * XZ_SCALE, 2)},
                "rot": i.get("rot"),     # raw T2 axis-angle (x y z deg)
                "scale": {"x": round(su * XZ_SCALE, 3), "y": round(sw * hs, 3), "z": round(sv * XZ_SCALE, 3)},
            }

        spec = {
            "mode": "ctf",
            "modes": ["ctf"],
            "bots": 8,
            "botFill": 10,
            "bases": {k: sxz(v) for k, v in flags.items()},
            "spawns": [ssphere(s) for s in spawns],
            "teamSpawns": {
                t: [ssphere(s) for s in spawns if s["team"] == t]
                for t in ("alpha", "bravo")
                if any(s["team"] == t for s in spawns)
            },
            "terrain": f"t2/{key}/terrain.bin",
            "terrainTex": f"t2/{key}/albedo.png",
            **({"sky": f"t2/{key}/sky"} if faces else {}),
            "interiors": [sinterior(i) for i in interiors],
            "_t2": f"ported from Tribes 2 '{mapname}' - relief {relief:.0f}m -> 125m",
            "_interiors": interiors,
        }
        (REPO / "maps" / f"{key}.json").write_text(json.dumps(spec, indent=2) + "\n")
        print(f"  -> maps/{key}.json + maps/t2/{key}/ ({len(interiors)} interiors)")


if __name__ == "__main__":
    main()
