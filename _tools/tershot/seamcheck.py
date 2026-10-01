# Cube-map seam checker for T2 sky exports.
# Decodes the six face PNGs, then verifies every shared cube edge for
# pixel continuity. --solve brute-forces the rotation (0/90/180/270) of
# each face that minimises total seam error under a chosen slot map.
#
#   python seamcheck.py <skydir> [--map px,nx,ny,py,pz,nz] [--solve]
#
# Slot order is always GL: [+x,-x,+y,-y,+z,-z].
import sys, itertools
from PIL import Image

def read_png(p):
    im = Image.open(p).convert('RGBA')
    w, h = im.size
    return w, h, im.tobytes()

def px(img, x, y, w):
    i = (y*w+x)*4; return img[i], img[i+1], img[i+2]

def rot90(img, w, h, k):  # k quarters CCW
    k %= 4
    if k == 0: return w, h, img
    out = bytearray(w*h*4)
    for y in range(h):
        for x in range(w):
            if k == 1: nx, ny = y, w-1-x
            elif k == 2: nx, ny = w-1-x, h-1-y
            else: nx, ny = h-1-y, x
            s = (y*w+x)*4; t = (ny*(h if k%2 else w)+nx)*4
            out[t:t+4] = img[s:s+4]
    return (h, w) if k % 2 else (w, h), out

# GL cube adjacency: for each face, which neighbor touches each edge, and
# in which direction the edge runs (for texel-wise compare).
# Faces: +X px, -X nx, +Y py, -Y ny, +Z pz, -Z nz (GL layout).
# edge tuples: (face, edge 0=T 1=R 2=B 3=L, neighbor, neighbor_edge, flip)
# Derived from the standard cubemap net (three.js/GL orientation).
ADJA = [
  ('px','T','py','R',True),('px','R','nz','T',False),('px','B','ny','R',True),('px','L','pz','T',False),
  ('nx','T','py','L',True),('nx','R','pz','T',False),('nx','B','ny','L',True),('nx','L','nz','T',False),
  ('py','T','nz','L',True),('py','R','px','T',False),('py','B','pz','L',True),('py','L','nx','T',False),
  ('ny','T','pz','B',False),('ny','R','px','B',False),('ny','B','nz','B',False),('ny','L','nx','B',False),
  ('pz','T','py','B',False),('pz','R','px','L',False),('pz','B','ny','T',False),('pz','L','nx','R',False),
  ('nz','T','py','T',False),('nz','R','nx','L',False),('nz','B','ny','B',False),('nz','L','px','R',False),
]

def edge(img, w, h, e):
    if e == 'T': return [px(img, x, 0, w) for x in range(w)]
    if e == 'B': return [px(img, x, h-1, w) for x in range(w)]
    if e == 'L': return [px(img, 0, y, w) for y in range(h)]
    return [px(img, w-1, y, w) for y in range(h)]

def seam_err(faces):
    # pairs discovered by edge_report on escalade — adjacency-by-content,
    # not assumed GL net orientation.
    return _seam_err_impl(faces)

def _seam_err_impl(faces):
    tot = 0; n = 0; worst = (0, '')
    seen = set()
    for f, e, g, ge, flip in ADJA:
        key = tuple(sorted([(f, e), (g, ge)]))
        if key in seen: continue
        seen.add(key)
        a = edge(*faces[f], e); b = edge(*faces[g], ge)
        if flip: b = b[::-1]
        s = sum(abs(p1[c]-p2[c]) for p1, p2 in zip(a, b) for c in range(3))
        tot += s; n += len(a)*3
        if s > worst[0]: worst = (s, f'{f}.{e}~{g}.{ge}')
    return tot / n, worst

def edge_report(names):
    """For every face edge, rank all other faces' edges by |diff|.
    A correctly-assembled cube has each face's claimed neighbors on top."""
    edges = {}
    for f, (w, h, img) in names.items():
        for e in 'TRBL':
            edges[(f, e)] = edge(img, w, h, e)
    print('edge -> best matches (mean|diff|/255, lower = tighter seam)')
    for f in names:
        for e in 'TRBL':
            a = edges[(f, e)]
            scores = []
            for (g, ge), b in edges.items():
                if g == f: continue
                for rev in (False, True):
                    bb = b[::-1] if rev else b
                    s = sum(abs(p1[c]-p2[c]) for p1, p2 in zip(a, bb) for c in range(3)) / (len(a)*3)
                    scores.append((s, g, ge, 'rev' if rev else 'fwd'))
            scores.sort()
            print(f'  {f}.{e}: ' + '  '.join(f'{g}.{ge}{r}={s:.0f}' for s, g, ge, r in scores[:3]))

def main():
    d = sys.argv[1].rstrip('/\\')
    slotmap = ['px','nx','py','ny','pz','nz']
    solve = '--solve' in sys.argv
    for i, a in enumerate(sys.argv):
        if a == '--map': slotmap = sys.argv[i+1].split(',')
    names = dict(zip(['px','nx','py','ny','pz','nz'],
                     [read_png(f'{d}/{f}.png') for f in ['px','nx','py','ny','pz','nz']]))
    for i, a in enumerate(sys.argv):
        if a == '--vflip':
            f = sys.argv[i+1]
            w, h, img = names[f]
            out = bytearray(w*h*4)
            for y in range(h):
                out[(h-1-y)*w*4:(h-y)*w*4] = img[y*w*4:(y+1)*w*4]
            names[f] = (w, h, out)
    edge_report(names)
    slots = ['px','nx','py','ny','pz','nz']
    faces = {slots[i]: names[slotmap[i]] for i in range(6)}
    avg, worst = seam_err(faces)
    print(f'slotmap {slotmap}: mean |diff| {avg:.1f}/255 per edge texel; worst {worst[1]} ({worst[0]})')
    if not solve:
        return
    best = None
    for rots in itertools.product(range(4), repeat=6):
        cand = {}
        for i, s in enumerate(slots):
            w, h, img = names[slotmap[i]]
            rw, rh, rimg = rot90(img, w, h, rots[i])
            cand[s] = (rw, rh, rimg)
        avg, worst = seam_err(cand)
        if best is None or avg < best[0]: best = (avg, rots, worst)
    print(f'best: mean {best[0]:.1f}  rots(px,nx,+Y,-Y,pz,nz)={best[1]}  worst {best[2][1]}')

main()
