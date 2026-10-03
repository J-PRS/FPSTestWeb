# Full cube assembler: searches slot permutations x per-face rotations.
# For each of the 720 slot assignments, coordinate-descent picks the
# rotation (of 4) minimising seam error per face, 3 rounds.
#   python skyperm.py <skydir>
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
# per-face adjacency index for coordinate descent
FACE_EDGES = {n: [] for n in NAMES}
for f,e,g,ge,fl in PAIRS:
    FACE_EDGES[f].append((e,g,ge,fl))
    FACE_EDGES[g].append((ge,f,e,fl))

def edges(im):
    w,h = im.size; p = im.tobytes()
    def px(x,y):
        i=(y*w+x)*3; return p[i]+p[i+1]+p[i+2]
    return {'T':[px(x,0) for x in range(w)],'B':[px(x,h-1) for x in range(w)],
            'L':[px(0,y) for y in range(h)],'R':[px(w-1,y) for y in range(h)]}

d = sys.argv[1]
FLIP = '--flip' in sys.argv
S = 32
imgs = {n: Image.open(d + '/' + n + '.png').convert('RGB').resize((S,S)) for n in NAMES}
ORIENTS = 8 if FLIP else 4
def orient(im, k):
    if k >= 4: im = im.transpose(Image.FLIP_LEFT_RIGHT)
    k %= 4
    return im.rotate(-90 * k, expand=True) if k else im
E = {n: [edges(orient(imgs[n], k)) for k in range(ORIENTS)] for n in NAMES}

def total(assign, rot):  # assign: slot->file, rot: slot->rot
    t = 0
    for f,e,g,ge,fl in PAIRS:
        a = E[assign[f]][rot[f]][e]; b = E[assign[g]][rot[g]][ge]
        if fl: b = b[::-1]
        t += sum(abs(x-y) for x,y in zip(a,b))
    return t

def solve(assign):
    rot = {s: 0 for s in NAMES}
    for _ in range(3):
        for slot in NAMES:
            best_r, best_s = 0, None
            for k in range(ORIENTS):
                rot[slot] = k
                s = total(assign, rot)
                if best_s is None or s < best_s: best_s, best_r = s, k
            rot[slot] = best_r
    return total(assign, rot), dict(rot)

# cap classification: a cap face is flat in BOTH directions; a side face
# has a strong gradient along some axis (the horizon). capScore = max
# directional gradient — the two lowest faces are the caps.
def grads(n):
    px = imgs[n].tobytes(); S = imgs[n].size[0]
    rows=[sum(px[r*S*3+c] for c in range(S*3))/(S*3) for r in range(S)]
    cols=[sum(px[r*S*3+c] for r in range(S))/(S*3) for c in range(S)]
    t=S//3
    vg=abs(sum(rows[:t])/t-sum(rows[S-t:])/t)
    hg=abs(sum(cols[:t])/t-sum(cols[S-t:])/t)
    return max(vg,hg)
ranked = sorted(NAMES, key=grads)
CAPS = set(ranked[:2])
up = max(CAPS, key=lambda n: LUM0[n]) if False else None
LUMF = {n: sum(imgs[n].tobytes()) for n in NAMES}
UP = max(CAPS, key=lambda n: LUMF[n]); DN = (CAPS - {UP}).pop()
print(f'  capScore: ' + ' '.join(f'{n}={grads(n):.0f}' for n in NAMES), f'-> up={UP} dn={DN}')
cands = []
for perm in itertools.permutations(NAMES):
    if perm[2] != UP or perm[3] != DN: continue  # py/ny slots = caps
    assign = dict(zip(NAMES, perm))
    s, rot = solve(assign)
    cands.append((s, tuple(perm), tuple(rot[k] for k in NAMES)))
cands.sort()
# identity reference
iassign = {n:n for n in NAMES}
isum, irot = solve(iassign)
best_s = cands[0][0]
# luminance per file
LUM = {n: sum(imgs[n].tobytes()) for n in NAMES}
def prior(perm, rots):
    a = dict(zip(NAMES, perm))
    p = LUM[a['py']] - LUM[a['ny']]
    for s in ('px','nx','pz','nz'):
        e = E[a[s]][rots[NAMES.index(s)]]
        t = sum(e['T']); b = sum(e['B'])
        p += 8*abs(t-b)
    return p
pick = max((c for c in cands if c[0] <= best_s*1.15), key=lambda c: prior(c[1], c[2]))
print(f'{d}')
print(f'  identity-assembled: {isum} rots={irot}')
print(f'  best seam: {best_s}')
print(f'  upright pick: seam={pick[0]} slot->file={dict(zip(NAMES,pick[1]))} rots={dict(zip(NAMES,pick[2]))}')
