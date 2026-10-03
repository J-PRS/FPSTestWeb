# Import w1.glb → find coplanar overlapping faces (the z-fight) → save disc.blend
import bpy, sys, mathutils

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=r'C:\TEMP\_WEB\FPSWebTest\_tools\vmdump\models\w1.glb')

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
print("MESHES:", [(o.name, len(o.data.polygons)) for o in meshes])

# Gather world-space polys with normal + plane d
polys = []
for o in meshes:
    mw = o.matrix_world
    for p in o.data.polygons:
        n = (mw.to_3x3() @ p.normal).normalized()
        c = mw @ p.center
        d = -n.dot(c)
        # verts world
        vs = [mw @ o.data.vertices[i].co for i in p.vertices]
        polys.append({'obj': o.name, 'n': n, 'd': d, 'c': c, 'vs': vs, 'idx': p.index})

def pt_in_tri(pt, tri, n):
    # project onto plane, barycentric inside test on dominant 2D axis
    from mathutils import Vector
    ax = max(range(3), key=lambda i: abs(n[i]))
    keep = [i for i in range(3) if i != ax]
    def f(v): return (v[keep[0]], v[keep[1]])
    (ax_, ay_), (bx, by), (cx, cy) = f(tri[0]), f(tri[1]), f(tri[2])
    px, py = f(pt)
    den = (by - cy) * (ax_ - cx) + (cx - bx) * (ay_ - cy)
    if abs(den) < 1e-12: return False
    l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den
    l2 = ((cy - ay_) * (px - cx) + (ax_ - cx) * (py - cy)) / den
    l3 = 1 - l1 - l2
    return l1 >= -1e-6 and l2 >= -1e-6 and l3 >= -1e-6

hits = 0
for i in range(len(polys)):
    for j in range(i + 1, len(polys)):
        a, b = polys[i], polys[j]
        if a['obj'] == b['obj']:
            continue  # different PARTS only — same-mesh coplanar adjacency is fine
        if a['n'].dot(b['n']) < 0.9999: continue
        if abs(a['n'].dot(b['c']) + a['d']) > 0.0005: continue  # b's center on a's plane
        # overlap test: any of b's verts inside any of a's tris (fan-triangulate)
        overlap = False
        for v in b['vs']:
            for k in range(1, len(a['vs']) - 1):
                if pt_in_tri(v, (a['vs'][0], a['vs'][k], a['vs'][k+1]), a['n']):
                    overlap = True; break
            if overlap: break
        if not overlap:
            for v in a['vs']:
                for k in range(1, len(b['vs']) - 1):
                    if pt_in_tri(v, (b['vs'][0], b['vs'][k], b['vs'][k+1]), b['n']):
                        overlap = True; break
                if overlap: break
        if overlap:
            hits += 1
            if hits <= 15:
                print(f"COPLANAR {a['obj']}#{a['idx']} × {b['obj']}#{b['idx']} n={tuple(round(x,2) for x in a['n'])} d={a['d']:.4f} c={tuple(round(x,3) for x in b['c'])}")
print("total coplanar overlaps:", hits)

bpy.ops.wm.save_as_mainfile(filepath=r'C:\TEMP\_WEB\FPSWebTest\_tools\vmdump\models\disc.blend')
print("SAVED disc.blend")
