#!/usr/bin/env python3
"""dif -> collision trimesh for KRIBES interiors.

Reads a T2 .dif via the io_dif parser (headless — hxDif needs no bpy) and
emits <name>.col.bin: u32 triCount + f32 x9 per tri, verts in T2 space.

Surfaces fan-triangulate through `windings` (point indices). Null surfaces
are skipped — they're the render-only faces (detail trim, decals); Torque
never collides on them.

Usage: python3 difcol.py <in.dif> <out.col.bin>
"""
import importlib.util
import struct
import sys
from pathlib import Path

HX = Path(__file__).resolve().parent / 'io_dif' / 'blender_plugin' / 'io_dif' / 'hxDif.py'
spec = importlib.util.spec_from_file_location('hxDif', HX)
hx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hx)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    dif = hx.Dif.read(hx.io_BytesReader(hx.haxe_io_Bytes.ofData(open(src, 'rb').read())))
    it = dif.interiors[0]  # detail level 0 — full geometry
    pts = it.points
    windings = it.windings
    tris = bytearray()
    n = 0
    for s in it.surfaces:
        base = s.windingStart
        cnt = s.windingCount
        if cnt < 3:
            continue
        poly = [pts[windings[base + k]] for k in range(cnt)]
        for k in range(1, cnt - 1):
            for v in (poly[0], poly[k], poly[k + 1]):
                tris += struct.pack('<fff', v.x, v.y, v.z)
            n += 1
    out = struct.pack('<I', n) + bytes(tris)
    Path(dst).write_bytes(out)
    print(f'{Path(src).name}: {n} tris -> {dst} ({len(out)} bytes)')


if __name__ == '__main__':
    main()
