# Edge-wear mask bake — produces w{N}_edge.png for vmBaked.loadEdgeTex.
# Appends the REAL edge-wear material from launcher.blend (the
# bevel-normal vs geometry-normal graph + its AO/cavity nodes) and
# EMIT-bakes it onto the weapon's OWN unwrap — the GLB must already
# carry UVs (the w{N}_baked.glb exports do). Usage:
#   blender -b --factory-startup -noaudio --python _tools/bake_edge_mask.py -- <in.glb> <out.png> [size]
import bpy, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, PNG = argv[0], argv[1]
SIZE = int(argv[2]) if len(argv) > 2 else 1024
LAUNCHER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launcher.blend")
# The bake has to see ONLY the mask — pick the launcher material whose
# node graph is the edge-wear one (first material with a Bevel node).
MASK_MAT_KEYWORD = 'Bevel'

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
gun = bpy.context.view_layer.objects.active

# The unwrap comes WITH the GLB — no Smart UV Project here, the mask has
# to land on the same texels the runtime's ao.png already uses.
assert gun.data.uv_layers, "GLB has no UV layer — unwrap upstream first"

# Append the launcher material verbatim — same nodes, same parameters.
with bpy.data.libraries.load(LAUNCHER) as (src, dst):
    mats = [m for m in src.materials]
    dst.materials = mats
mat = None
for m in dst.materials:
    if m and m.use_nodes and any(n.type == 'ShaderNodeBevel' for n in m.node_tree.nodes):
        mat = m
        break
if mat is None and dst.materials:
    mat = dst.materials[0]
assert mat, "no material found in launcher.blend"
print("using material:", mat.name)
gun.data.materials.clear()
gun.data.materials.append(mat)
nt = mat.node_tree

img = bpy.data.images.new("EDGE_OUT", SIZE, SIZE)
img.colorspace_settings.name = 'Non-Color'
inode = nt.nodes.new('ShaderNodeTexImage')
inode.image = img
inode.select = True
nt.nodes.active = inode

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 64
sc.render.bake.margin = 16

for o in bpy.context.view_layer.objects:
    o.select_set(False)
gun.select_set(True)
bpy.context.view_layer.objects.active = gun
bpy.ops.object.bake(type='EMIT', use_clear=True)
img.save_render(PNG)
print("EDGE_BAKED", PNG)
