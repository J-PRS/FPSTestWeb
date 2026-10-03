# Downsampled cube-rotation solver: 64px faces, brute-forces the
# per-face quarter-turn set (4^6) that minimises total seam error.
#   python skysolve.py <skydir> [skydir2 ...]
import sys, itertools
from PIL import Image

NAMES = ['px','nx','py','ny','pz','nz']
ADJA = [
  ('px','T','py','R',True),('px','R','nz','T',False),('px','B','ny','R',True),('px','L','pz','T',False),
  ('nx','T','py','L',True),('nx','R','pz','T',False),('nx','B','ny','L',True),('nx','L','nz','T',False),
  ('py','T','nz','L',True),('py','R','px','T',False),('py','B','pz','L',True),('py','L','nx','T',False),
  ('ny','T','pz','B',False),('ny','R','px','B',False),('ny','B','nz','B',False),('ny','L','nx','B',False),
  ('pz','T','py','B',False),('pz','R','px','L',False),('pz','B','ny','T',False),('pz','L','nx','R',False),
  ('nz','T','py','T',False),('nz','R','nx','L',False),('nz','B','ny','B',False),('nz','L','px','R',False),
]
PAIRS = []
_seen = set()
for f,e,g,ge,fl in ADJA:
    k = tuple(sorted([(f,e),(g,ge)]))
    if k in _seen: continue
    _seen.add(k); PAIRS.append((f,e,g,ge,fl))

def edges(im):
    w,h = im.size; p = im.tobytes()
    def px(x,y):
        i=(y*w+x)*3; return p[i]+p[i+1]+p[i+2]
    return {'T':[px(x,0) for x in range(w)],'B':[px(x,h-1) for x in range(w)],
            'L':[px(0,y) for y in range(h)],'R':[px(w-1,y) for y in range(h)]}

def solve(d):
    small = {}
    for n in NAMES:
        small[n] = Image.open(d + '/' + n + '.png').convert('RGB').resize((64,64))
    E = {n: [edges(small[n].rotate(-90*k, expand=True) if k else small[n]) for k in range(4)] for n in NAMES}
    def err(rot):
        tot = 0
        for f,e,g,ge,fl in PAIRS:
            a = E[f][rot[f]][e]; b = E[g][rot[g]][ge]
            if fl: b = b[::-1]
            tot += sum(abs(x-y) for x,y in zip(a,b))
        return tot
    best = None
    for rots in itertools.product(range(4),repeat=6):
        r = dict(zip(NAMES,rots))
        s = err(r)
        if best is None or s < best[0]: best = (s, rots)
    ident = err({n:0 for n in NAMES})
    print(f'{d}: identity={ident}  best={best[0]}  rots(px,nx,py,ny,pz,nz)={best[1]}', flush=True)

for d in sys.argv[1:]:
    try: solve(d)
    except Exception as e: print(f'{d}: {e}', flush=True)
