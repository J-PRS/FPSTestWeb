"""Cubemap -> equirectangular preview for checking face assignment.

Usage: skyview.py <sky_dir> [--map px=px nx=nx py=py ny=ny pz=pz nz=nz] [--rot pz=2] [--vflip px] [--out out.png]

GL slot -> which file fills it, plus per-file quarter-turn rotation and
vertical flip. Renders <dir>/_preview.png by default.
"""
import math, sys
from PIL import Image

SLOTS = ['px', 'nx', 'py', 'ny', 'pz', 'nz']


def face_uv(dx, dy, dz):
    """Return (u, v) in [0,1] for GL cube sampling of a unit-ish dir."""
    ax, ay, az = abs(dx), abs(dy), abs(dz)
    if ax >= ay and ax >= az:
        if dx > 0:  # +X
            s, t, m, slot = -dz, -dy, ax, 'px'
        else:       # -X
            s, t, m, slot = dz, -dy, ax, 'nx'
    elif ay >= ax and ay >= az:
        if dy > 0:  # +Y
            s, t, m, slot = dx, dz, ay, 'py'
        else:       # -Y
            s, t, m, slot = dx, -dz, ay, 'ny'
    else:
        if dz > 0:  # +Z
            s, t, m, slot = dx, -dy, az, 'pz'
        else:       # -Z
            s, t, m, slot = -dx, -dy, az, 'nz'
    return (s / m + 1) / 2, (t / m + 1) / 2, slot


def sample(imgs, mapping, rot, vflip, dx, dy, dz):
    u, v, slot = face_uv(dx, dy, dz)
    fname = mapping[slot]
    r = rot.get(fname, 0)
    img, w, h = imgs[fname]
    if vflip and fname in vflip:
        v = 1 - v
    for _ in range(r % 4):  # rotate sample point CCW around face center
        u, v = 1 - v, u
    x = min(w - 1, max(0, int(u * w)))
    y = min(h - 1, max(0, int(v * h)))
    i = (y * w + x) * 4
    return img[i], img[i + 1], img[i + 2]


def render(d, mapping, rot, vflip, out, ow=1024, oh=512):
    imgs = {}
    for f in set(mapping.values()):
        im = Image.open(f'{d}/{f}.png').convert('RGBA')
        imgs[f] = (im.tobytes(), im.width, im.height)
    res = Image.new('RGB', (ow, oh))
    px = res.load()
    for y in range(oh):
        lat = math.pi * (0.5 - y / oh)
        cy, sy = math.cos(lat), math.sin(lat)
        for x in range(ow):
            lon = 2 * math.pi * (x / ow - 0.5)
            px[x, y] = sample(imgs, mapping, rot, vflip,
                              cy * math.sin(lon), sy, cy * math.cos(lon))
    res.save(out)
    print('wrote', out)


def main():
    d = sys.argv[1]
    mapping = {s: s for s in SLOTS}
    rot, vflip = {}, set()
    out = f'{d}/_preview.png'
    i = 2
    while i < len(sys.argv):
        a = sys.argv[i]
        if a == '--map':
            j = i + 1
            while j < len(sys.argv) and '=' in sys.argv[j] and not sys.argv[j].startswith('--'):
                k, v = sys.argv[j].split('=')
                mapping[k] = v
                j += 1
            i = j - 1
        elif a == '--rot':
            j = i + 1
            while j < len(sys.argv) and '=' in sys.argv[j] and not sys.argv[j].startswith('--'):
                k, v = sys.argv[j].split('=')
                rot[k] = int(v)
                j += 1
            i = j - 1
        elif a == '--vflip':
            vflip.update(sys.argv[i + 1].split())
            i += 1
        elif a == '--out':
            out = sys.argv[i + 1]
            i += 1
        i += 1
    render(d, mapping, rot, vflip, out)


main()
