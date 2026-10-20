#!/usr/bin/env python3
"""Tribes 1 mission -> our map pipeline (.bin heightfield + spec JSON).

T1 layout differs from the T2 port (mis2spec.py):
  - objects are `instant Cls "name" { ... }` not `new Cls("name") { ... }`
  - teams are TeamGroup "Team0"|"Team1"  (=> alpha|bravo)
  - flag stand  = Item "flag"            inside the TeamGroup
  - team spawns = Marker "Drop Point"    inside SimGroup "DropPoints"
  - buildings   = InteriorShape (T1 .dif — we can't render them; terrain
    still carries the baked base shadows, so the stands read fine)
  - terrain     = a zip .ted holding a GBLK .dtb (quadtree blocks handled
    by the vendored TribesToBlender decoder in t1terrain/)

T1 playfield is the MIDDLE of a 3x3-tiled 2048m tile — mission coords sit
inside [-1024,1024], which is exactly our tileSize:2048 wrap. Heights are
compressed into u8 with spec.heightScale = relief/125 (same trick the T2
ports use: ctf.bin 0..255 -> 0..125m * heightScale).

Usage: python3 t1import.py <mission.mis> [--name outname] [--mode ctf] [--bots 6]
Emits:  maps/t1/<name>/terrain.bin  +  maps/<name>.json
"""
import json
import math
import os
import re
import struct
import sys
import zipfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from t1terrain import terrain as _terrain  # noqa: E402

INSTANT_RE = re.compile(r'instant\s+(\w+)\s+"([^"]*)"\s*\{')
FIELD_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"\s*;')

TILE_M = 2048.0          # T1 tile span — mission coords live in [-1024,1024]
HM_SCALE_M = 125.0       # our u8->meter scale before spec.heightScale


def match_brace(src, open_idx):
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return i + 1
    return len(src)


def parse_fields(block):
    return {m.group(1): m.group(2) for m in FIELD_RE.finditer(block)}


def parse_objs(src, start=0, end_limit=None, team=None, in_drops=False):
    """Yield (cls, name, fields, team, in_drops) — team from enclosing
    TeamGroup, in_drops from enclosing SimGroup "DropPoints"."""
    pos = start
    limit = end_limit if end_limit is not None else len(src)
    while True:
        m = INSTANT_RE.search(src, pos)
        if not m or m.start() >= limit:
            return
        open_brace = src.index('{', m.end() - 1)
        end = match_brace(src, open_brace)
        body = src[open_brace + 1:end - 1]
        cls, name = m.group(1), m.group(2).strip()
        if cls in ('SimGroup', 'TeamGroup', 'DropPointGroup'):
            t = team
            if name.lower() in ('team0', 'team1'):
                t = 'alpha' if name.lower() == 'team0' else 'bravo'
            yield from parse_objs(src, open_brace + 1, end - 1,
                                  t, in_drops or name.lower() == 'droppoints')
        else:
            yield cls, name, parse_fields(body), team, in_drops
        pos = end


def vec3(s):
    try:
        v = [float(x) for x in (s or '').split()[:3]]
    except ValueError:
        v = []
    return v + [0.0] * (3 - len(v))


def load_ted(ted_path):
    """-> (terrain.terrain object)."""
    z = zipfile.ZipFile(ted_path)
    names = z.namelist()
    t = _terrain.terrain()
    dtf = [n for n in names if n.lower().endswith('.dtf')]
    dtb = [n for n in names if n.lower().endswith('.dtb')]
    if dtf:
        t.load_dtf_binary(z.read(dtf[0]))
    t.load_binary(z.read(dtb[0]))
    return t


# T1 material palette -> our procedural terrainPreset ids (0 mixed,
# 1 desert, 2 grassland, 3 snow, 4 volcanic, 5 badlands, 6 coast).
DML_PRESET = {'lush': 2, 'ice': 3, 'snow': 3, 'desert': 1, 'mars': 5,
              'volcanic': 4, 'alien': 0, 'human1': 1, 'savana': 1}
DML_SNOWY = {'ice', 'snow'}


def orient(hm, flip):
    h = hm
    if flip & 1:
        h = h[::-1, :]
    if flip & 2:
        h = h[:, ::-1]
    if flip & 4:
        h = h.T.copy()
    return h


def calibrate(hm, anchors):
    """T1 mission coords aren't centered on the tile and the .dtb row
    order differs from world axes — brute-force the dihedral flip plus
    the (dx,dy) offset that puts every anchor on its baked dirt.
    anchors = [(mis_x, mis_y, mis_z), ...].  -> (hm_oriented, dx, dy)"""
    n = hm.shape[0] - 1
    cell = TILE_M / n
    best = None
    for flip in range(8):
        h = orient(hm[:n, :n], flip)
        for dxi in range(-2048, 2048, 16):
            for dyi in range(-2048, 2048, 16):
                err = 0.0
                for x, y, mz in anchors:
                    i = int(((x + dxi) / TILE_M + 0.5) * n)
                    j = int(((y + dyi) / TILE_M + 0.5) * n)
                    if not (0 <= i < n and 0 <= j < n):
                        err = 1e9
                        break
                    err += abs(float(h[j, i]) - mz)
                if best is None or err < best[0]:
                    best = (err, flip, dxi, dyi)
    err, flip, dx, dy = best
    # refine to the nearest meter
    h = orient(hm[:n, :n], flip)
    for dxi in range(dx - 16, dx + 17):
        for dyi in range(dy - 16, dy + 17):
            e = 0.0
            for x, y, mz in anchors:
                i = int(((x + dxi) / TILE_M + 0.5) * n)
                j = int(((y + dyi) / TILE_M + 0.5) * n)
                e += abs(float(h[j, i]) - mz) if 0 <= i < n and 0 <= j < n else 1e9
            if e < err:
                err, dx, dy = e, dxi, dyi
    return orient(hm, flip), dx, dy, err


def write_bin(heightmap, fmin, relief, out_path):
    """Meters -> u8 grid covering the relief; caller drops the 257th
    edge vertex (the source grid IS the tile, 256 cells)."""
    n = heightmap.shape[0]
    u8 = np.clip((heightmap - fmin) / max(relief, 1e-6) * 255.0, 0, 255).astype(np.uint8)
    with open(out_path, 'wb') as f:
        f.write(struct.pack('<II', n, n))
        f.write(u8.tobytes())
    return n


def main():
    mis_path = sys.argv[1]
    args = sys.argv[2:]
    def arg(k, d):
        return args[args.index(k) + 1] if k in args else d

    name = arg('--name', os.path.splitext(os.path.basename(mis_path))[0].lower())
    mode = arg('--mode', 'ctf')
    bots = int(arg('--bots', '6'))

    src = open(mis_path, encoding='latin-1').read()
    ted = load_ted(os.path.splitext(mis_path)[0] + '.ted')
    raw, fmin, fmax = ted.heightmap, float(ted.height_fmin), float(ted.height_fmax)
    dml = (ted.dml_name or b'').decode('latin-1').split('.')[0].lower()
    relief = fmax - fmin
    n = raw.shape[0] - 1
    cell = TILE_M / n  # meters per heightmap cell (8m at 256)

    objects = [(cls, nm, f, team, in_drops) for cls, nm, f, team, in_drops in parse_objs(src)]

    # Calibration anchors: flag stands first, else drop markers (both sit
    # on dirt). InteriorShape z lies because turrets ride towers.
    anchors = [vec3(f.get('position')) for cls, nm, f, t, d in objects
               if (cls == 'Item' and nm.startswith('flag') and t)]
    if len(anchors) < 2:
        anchors = [vec3(f.get('position')) for cls, nm, f, t, d in objects
                   if cls == 'Marker' and d]
    hm, dx, dy, cerr = calibrate(raw, anchors)
    print(f'  calibrated: dx={dx} dy={dy} residual={cerr:.2f}m over {len(anchors)} anchors')

    def ground(wx, wz):
        u = (wx / TILE_M + 0.5) * n - 0.5
        v = (wz / TILE_M + 0.5) * n - 0.5
        x0, z0 = math.floor(u) % n, math.floor(v) % n
        fx, fz = u - math.floor(u), v - math.floor(v)
        x1, z1 = (x0 + 1) % n, (z0 + 1) % n
        return (hm[z0, x0] * (1 - fx) * (1 - fz) + hm[z0, x1] * fx * (1 - fz)
                + hm[z1, x0] * (1 - fx) * fz + hm[z1, x1] * fx * fz)

    bases, base_mz, team_spawns, spawns = {}, {}, {'alpha': [], 'bravo': []}, []
    sky_f = planet_f = {}
    for cls, nm, f, team, in_drops in objects:
        pos = vec3(f.get('position'))
        if cls == 'Sky':
            sky_f = f
        elif cls == 'Planet':
            planet_f = f
        if cls == 'Item' and nm.startswith('flag') and team:
            bases[team] = {'x': round(pos[0] + dx, 1), 'y': 0, 'z': round(pos[1] + dy, 1)}
            base_mz[team] = pos[2]
        elif cls == 'Marker' and in_drops:
            e = {'x': round(pos[0] + dx, 1), 'y': 0, 'z': round(pos[1] + dy, 1), 'r': 6.0}
            (team_spawns[team] if team else spawns).append(e)

    # Sanity: flag stand sits on its own dirt (T1 z should match ground).
    for t, b in bases.items():
        print(f'  base {t}: mis z {base_mz[t]:.1f} vs terrain {ground(b["x"], b["z"]):.1f}m')

    out_dir = os.path.join('maps', 't1', name)
    os.makedirs(out_dir, exist_ok=True)
    cells = write_bin(hm[:n, :n], fmin, relief, os.path.join(out_dir, 'terrain.bin'))

    spec = {
        'mode': mode,
        'bots': bots,
        'terrain': f't1/{name}/terrain.bin',
        'tileSize': TILE_M,
        'heightScale': round(relief / HM_SCALE_M, 4),
    }
    # Look: DML palette -> terrain preset; T1 sun -> procedural atmosphere
    # (azimuth maps directly, incidence (deg over horizon) bends into the
    # 0-1 timeOfDay where .25=sunrise/.5=noon).
    if dml in DML_PRESET:
        spec['terrainPreset'] = DML_PRESET[dml]
    if dml in DML_SNOWY:
        spec['weather'] = {'snow': 0.8, 'dust': 0.2}
    az, inc = float(planet_f.get('azimuth') or 0), float(planet_f.get('incidence') or 45)
    spec['atmosphere'] = {'sunAzimuth': round(az % 360, 1),
                          'timeOfDay': round(0.25 + inc / 360.0, 3)}
    sky_col = vec3(sky_f.get('skyColor'))
    if any(c > 0.01 for c in sky_col):
        col = [round(c, 4) for c in sky_col]
        spec['fog'] = {'color': col, 'horizon': col, 'distance': 500, 'visible': 3000}
    if bases:
        spec['bases'] = bases
    if any(team_spawns.values()):
        spec['teamSpawns'] = team_spawns
    if spawns:
        spec['spawns'] = spawns
    spec['_t1'] = {'source': os.path.basename(mis_path),
                   'relief': round(relief, 1), 'fmin': round(fmin, 1)}

    dest = os.path.join('maps', f'{name}.json')
    json.dump(spec, open(dest, 'w'), indent=2)
    print(f'wrote {dest} + {out_dir}/terrain.bin '
          f'({cells}x{cells}, {cell:.1f}m cells, relief {relief:.0f}m, '
          f'bases={list(bases)}, spawns={sum(len(v) for v in team_spawns.values()) + len(spawns)})')


if __name__ == '__main__':
    main()
