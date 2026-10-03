import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=r'C:\TEMP\_WEB\FPSWebTest\_tools\vmdump\models\w1.glb')
for o in bpy.context.scene.objects:
    if o.type != 'MESH': continue
    mw = o.matrix_world
    bb = [mw @ __import__('mathutils').Vector(c) for c in o.bound_box]
    lo = [round(min(v[i] for v in bb),3) for i in range(3)]
    hi = [round(max(v[i] for v in bb),3) for i in range(3)]
    cols = [l.name for l in o.data.vertex_colors]
    print(f"{o.name}: tris={len(o.data.polygons)} scale={tuple(round(s,3) for s in o.scale)} bbox x[{lo[0]},{hi[0]}] y[{lo[1]},{hi[1]}] z[{lo[2]},{hi[2]}] vcols={cols}")
