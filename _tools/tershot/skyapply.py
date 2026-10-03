# Applies a slot-remap + rotation assembly to a sky dir (writes to out dir),
# then prints the full-res seam score so the solve can be verified.
#   python skyapply.py <skydir> <outdir> "<assign>" "<rots>"
# assign/rots: python dicts, e.g. "{'px':'nz',...}" "{'px':1,...}"
import sys, ast, os
from PIL import Image

NAMES = ['px','nx','py','ny','pz','nz']
d, out = sys.argv[1], sys.argv[2]
assign = ast.literal_eval(sys.argv[3])
rots = ast.literal_eval(sys.argv[4])
os.makedirs(out, exist_ok=True)
for slot in NAMES:
    im = Image.open(d + '/' + assign[slot] + '.png')
    k = rots.get(slot, 0)
    if k: im = im.rotate(-90 * k, expand=True)
    im.save(out + '/' + slot + '.png')
print('wrote', out)
