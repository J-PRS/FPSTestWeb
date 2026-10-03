# Export the launcher.blend weapon as ONE GLB — joins every mesh object
# (it ships as a few combined objects) with transforms applied, so the
# result loads as a single mesh on the w{N}_baked.glb path. Usage:
#   blender -b --factory-startup -noaudio _tools/launcher.blend --python _tools/export_launcher.py -- <out.glb>
import bpy, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]

# Only what the main scene's view layer already sees — hidden or
# disabled-collection objects are intentionally excluded.
meshes = [o for o in bpy.context.view_layer.objects if o.type == 'MESH']
assert meshes, "no mesh objects in launcher.blend's view layer"

# The model is built on Mirror/other modifiers — joining the raw
# objects exports only the authored half. Snapshot each object through
# the evaluated depsgraph: modifiers (Mirror, Bevel, Solidify...) bake
# into real geometry before the join.
dg = bpy.context.evaluated_depsgraph_get()
sc_col = bpy.context.scene.collection
eval_objs = []
for o in meshes:
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), depsgraph=dg)
    no = bpy.data.objects.new(o.name, me)
    no.matrix_world = o.matrix_world.copy()
    sc_col.objects.link(no)
    eval_objs.append(no)
# The raw objects export too otherwise — the scene would ship both the
# authored halves and their evaluated copies stacked.
for o in meshes:
    bpy.data.objects.remove(o)

# Select all meshes → join into the first. Blender applies each object's
# world transform into the joined data, so hierarchy/import axes bake in.
bpy.ops.object.select_all(action='DESELECT')
for o in eval_objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = eval_objs[0]
if len(eval_objs) > 1:
    bpy.ops.object.join()
gun = bpy.context.view_layer.objects.active
gun.name = "launcher"

# Apply residual object scale/rotation so the GLB is clean for three.js.
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

# Viewmodel fit: the blend's barrel runs +Z in meters (Unity scale);
# viewmodel space wants ~0.67 units along glTF -Z. Rotating -90° about X
# puts Blender +Z onto +Y, which export_yup carries to glTF -Z (the
# procedural weapons' forward/muzzle direction).
import math
from mathutils import Vector
scale = 0.67 / (gun.dimensions.z if gun.dimensions.z else 1.0)
gun.rotation_euler = (math.radians(-90), 0, 0)
gun.scale = (scale, scale, scale)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# The blend's mesh lives away from its origin — recenter the bbox on
# (0,0,0) like the procedural weapons, or the viewmodel holds it 2.5
# units off to the side and the fps cam frames empty air.
bb = [gun.matrix_world @ Vector(c) for c in gun.bound_box]
ctr = Vector(((min(v.x for v in bb) + max(v.x for v in bb)) / 2,
              (min(v.y for v in bb) + max(v.y for v in bb)) / 2,
              (min(v.z for v in bb) + max(v.z for v in bb)) / 2))
for v in gun.data.vertices:
    v.co -= ctr

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    use_selection=False,
    export_apply=True,
    export_yup=True,
    export_materials='EXPORT',
    export_image_format='AUTO',
)
print("EXPORTED", OUT, "verts:", len(gun.data.vertices), "tris:", len(gun.data.polygons))
