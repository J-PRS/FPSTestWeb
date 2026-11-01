import struct, json, heapq, sys
import numpy as np
inp, out = sys.argv[1], sys.argv[2]
with open(inp,'rb') as f: N = struct.unpack('<I', f.read(4))[0]; Nh = struct.unpack('<I', f.read(4))[0]
h = np.fromfile(inp, dtype=np.uint8, offset=8).reshape(Nh,N).astype(np.float32)
spec = json.load(open(inp.replace('.bin','.json')))
mPerByte = 125 * (spec.get('heightScale',1)) / 255
texel = (spec.get('tileSize',1500)) / N

# Priority-flood gives the spill-height map
filled = h.copy(); seen = np.zeros((Nh,N), bool); pq = []
for i in range(N):
    for (x,y) in [(i,0),(i,Nh-1),(0,i),(N-1,i)]:
        heapq.heappush(pq,(h[y,x],y,x)); seen[y,x]=True
n8=[(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
while pq:
    z,y,x = heapq.heappop(pq)
    for dx,dy in n8:
        nx,ny=x+dx,y+dy
        if nx<0 or ny<0 or nx>=N or ny>=Nh or seen[ny,nx]: continue
        seen[ny,nx]=True
        nz = max(h[ny,nx], z)
        filled[ny,nx]=nz
        heapq.heappush(pq,(nz,ny,nx))
lift = filled - h

# Local-pit mask: blur-h > threshold = narrow hole, not a canyon floor.
R = max(2, round(80 / texel))  # ~80m context
from scipy.ndimage import uniform_filter
blur = uniform_filter(h, size=2*R+1, mode='reflect')
mask = (blur - h) > (18 / mPerByte)   # pits deeper than ~18m vs their rim

apply = mask & (lift > 0)
filled[apply] = filled[apply]
out_h = np.where(apply, filled, h)
raised = int(apply.sum()); maxlift = float(lift[apply].max()) if raised else 0.0
out_h = np.clip(np.rint(out_h),0,255).astype(np.uint8)
with open(out,'wb') as f:
    f.write(struct.pack('<II',N,Nh)); out_h.tofile(f)
print(f'pitfill2: {raised} cells filled inside narrow pits, max lift {maxlift*mPerByte:.0f}m, untouched {int((~apply).sum())}')
