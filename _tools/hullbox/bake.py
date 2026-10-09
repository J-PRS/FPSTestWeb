# Bake world-space AABBs for every interior in a map spec.
# interiors carry file/pos/rot(axis-angle)/scale only — colliders and bot
# pathing need real extents, which live inside each dif->glb mesh. Reads the
# GLB JSON chunk, walks the node graph applying TRS to each POSITION
# accessor's min/max box, unions to a local AABB, then folds the spec's own
# rot+scale+pos into a fattened world AABB.
# Usage: bake.py maps/raindance_nef.json   -> writes maps/t2/<map>/hullboxes.json
import json, struct, sys, os, math

DIF_DIR = 'maps/t2/dif'

def glb_bounds(path):
    with open(path, 'rb') as f:
        data = f.read()
    ln = struct.unpack_from('<I', data, 12)[0]
    g = json.loads(data[20:20 + ln])
    nodes, accs = g.get('nodes', []), g.get('accessors', [])

    def compose(n):
        if 'matrix' in n:
            m = n['matrix']  # column-major
            return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]],
                    [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]]
        t = n.get('translation', [0, 0, 0]); q = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
        x, y, z, w = q
        r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
             [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
             [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        return [[r[i][j] * s[j] for j in range(3)] + [t[i]] for i in range(3)] + [[0, 0, 0, 1]]

    def matmul(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]

    def xform(m, p):
        return [m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] for i in range(3)]

    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    lo = [math.inf] * 3; hi = [-math.inf] * 3
    meshes = g.get('meshes', [])

    def walk(idx, parent):
        n = nodes[idx]
        m = matmul(parent, compose(n))
        if 'mesh' in n:
            for prim in meshes[n['mesh']].get('primitives', []):
                ai = prim.get('attributes', {}).get('POSITION')
                if ai is None or 'min' not in accs[ai]:
                    continue
                mn, mx = accs[ai]['min'], accs[ai]['max']
                for cx in (mn[0], mx[0]):
                    for cy in (mn[1], mx[1]):
                        for cz in (mn[2], mx[2]):
                            p = xform(m, [cx, cy, cz])
                            for i in range(3):
                                lo[i] = min(lo[i], p[i]); hi[i] = max(hi[i], p[i])
        for c in n.get('children', []):
            walk(c, m)

    scene = g.get('scenes', [{}])[g.get('scene', 0)]
    for r in scene.get('nodes', []):
        walk(r, I)
    return lo, hi

def aa_rotate(p, axis, deg):
    x, y, z = axis
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    k = [x, y, z]
    dot = p[0] * k[0] + p[1] * k[1] + p[2] * k[2]
    cr = [k[1] * p[2] - k[2] * p[1], k[2] * p[0] - k[0] * p[2], k[0] * p[1] - k[1] * p[0]]
    return [p[i] * c + cr[i] * s + k[i] * dot * (1 - c) for i in range(3)]

def main(spec_path):
    spec = json.load(open(spec_path))
    name = os.path.splitext(os.path.basename(spec_path))[0]
    out = []
    missing = []
    for it in spec.get('interiors') or []:
        glb = os.path.join(DIF_DIR, it['file'].rsplit('.', 1)[0] + '.glb')
        if not os.path.exists(glb):
            missing.append(it['file']); continue
        lo, hi = glb_bounds(glb)
        sc = it.get('scale') or {'x': 1, 'y': 1, 'z': 1}
        rot = it.get('rot') or [0, 1, 0, 0]
        wlo = [math.inf] * 3; whi = [-math.inf] * 3
        for cx in (lo[0], hi[0]):
            for cy in (lo[1], hi[1]):
                for cz in (lo[2], hi[2]):
                    p = [cx * sc['x'], cy * sc['y'], cz * sc['z']]
                    if rot[3] % 360:
                        p = aa_rotate(p, rot[:3], rot[3])
                    p = [p[0] + it['pos']['x'], p[1] + it['pos']['y'], p[2] + it['pos']['z']]
                    for i in range(3):
                        wlo[i] = min(wlo[i], p[i]); whi[i] = max(whi[i], p[i])
        out.append({'file': it['file'], 'min': [round(v, 2) for v in wlo], 'max': [round(v, 2) for v in whi]})
    dst = os.path.join('maps/t2', name, 'hullboxes.json')
    json.dump(out, open(dst, 'w'))
    print(f'{name}: {len(out)} hullboxes -> {dst}', f'MISSING: {missing}' if missing else '')

if __name__ == '__main__':
    for p in sys.argv[1:]:
        main(p)
