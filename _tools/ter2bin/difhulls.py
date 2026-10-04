#!/usr/bin/env python3
"""Emit .dif convex-hull collision into a map spec's structures[].

T2 interiors carry Torque convexHulls — the authentic collision set, so
hollow buildings stay enterable. Each hull's local AABB becomes one
yaw-OBB 'hull' structure (collision-only; SolidWorld/structureColliders
handle them like any box).

Frames (mirrors client/src/game/net/mapAssets.ts):
  T2 hull axes (u,v,w) -> ours-local (x=u, y=w, z=v); interior yaw a deg
  about w renders as rotY = -deg (SwapYZ mirror conjugation); spec.scale
  is already in OUR axes and scales the ours-local box.

  python _tools/ter2bin/difhulls.py <mapkey> [--difdir maps/t2/dif]
"""
import sys, json, math, importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

def load_hxdif():
    spec = importlib.util.spec_from_file_location(
        'hxDif', ROOT / '_tools/io_dif/blender_plugin/io_dif/hxDif.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

MIN_EXT = 1.0     # drop dust/detail hulls under a meter in every axis
MIN_VOL = 0.15    # and hulls with negligible volume (flat slivers)

def main():
    key = sys.argv[1]
    difdir = ROOT / (sys.argv[sys.argv.index('--difdir') + 1] if '--difdir' in sys.argv else 'maps/t2/dif')
    spec_path = ROOT / f'maps/{key}.json'
    spec = json.loads(spec_path.read_text())
    hx = load_hxdif()

    cache = {}
    out = []
    skipped = 0
    for i in spec.get('interiors', []):
        name = i['file']
        dif_path = difdir / name
        if not dif_path.exists():
            skipped += 1
            continue
        if name not in cache:
            d = hx.Dif.Load(str(dif_path))
            cache[name] = d.interiors[0].convexHulls if d.interiors else []
        hulls = cache[name]

        p = i['pos']; s = i.get('scale', {'x': 1, 'y': 1, 'z': 1})
        rot = i.get('rot') or [0, 0, 0, 0]
        # Yaw-only T2 interiors: any non-w axis would need full OBBs our
        # collider type can't express — flagged rather than approximated.
        ax = rot[:3] if len(rot) >= 3 else [0, 0, 0]
        if (abs(ax[0]) > 1e-6 or abs(ax[1]) > 1e-6) and abs(rot[3]) > 1e-6:
            print(f'  WARN {name}: non-yaw rotation {rot} — hull yaw only')
        rot_y = -math.radians(rot[3]) if len(rot) >= 4 else 0.0
        c, sn = math.cos(rot_y), math.sin(rot_y)

        for h in hulls:
            # .dif hull bounds are stored interleaved per axis —
            # (minX,maxX,minY,maxY,minZ,maxZ) — NOT minXYZ/maxXYZ.
            # Reading them grouped scrambles y/z into world offsets
            # ~90m from the mesh (verified vs the hull's own vertex run).
            u0, u1 = h.minX, h.minY
            v0, v1 = h.minZ, h.maxX
            w0, w1 = h.maxY, h.maxZ
            eu, ev, ew = u1 - u0, v1 - v0, w1 - w0
            if max(eu, ev, ew) < MIN_EXT or eu * ev * ew < MIN_VOL:
                continue
            # ours-local center/extents: u->x, w->y, v->z (spec.scale axes)
            lx = (u0 + u1) / 2 * s['x']
            ly = (w0 + w1) / 2 * s['y']
            lz = (v0 + v1) / 2 * s['z']
            sx, sy, sz = eu * s['x'], ew * s['y'], ev * s['z']
            # yaw the center into world space — rendered offset is
            # R(-theta) in T2 (u,v) space: u' = u c + v s, v' = -u s + v c
            # with c=cos(theta), s=sin(theta); rot_y=-theta makes c,s land
            # exactly as the mesh's own transform computes them.
            cx = p['x'] + lx * c - lz * sn
            cz = p['z'] + lx * sn + lz * c
            cy = p['y'] + ly
            out.append({
                'kind': 'hull',
                # StructureSpec pos is the box's BASE center
                'pos': {'x': round(cx, 2), 'y': round(cy - sy / 2, 2), 'z': round(cz, 2)},
                'size': {'x': round(sx, 2), 'y': round(sy, 2), 'z': round(sz, 2)},
                'rotY': round(rot_y, 5),
            })

    spec['structures'] = [s for s in spec.get('structures', []) if s.get('kind') != 'hull'] + out
    spec_path.write_text(json.dumps(spec, indent=2) + '\n')
    print(f'{key}: emitted {len(out)} hull colliders ({skipped} interiors without dif)')

if __name__ == '__main__':
    main()
