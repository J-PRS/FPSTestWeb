# AO bake — produces w{N}_ao.png consumed as the baked mesh's `map`
# (albedo × AO composite, matching the old pipeline's LinearSRGB load).
# Bakes onto the GLB's OWN unwrap — asserts UVs exist, never re-unwraps.
# Usage:
#   blender -b --factory-startup -noaudio --python _tools/bake_ao.py -- <in.glb> <out.png> [size]
import bpy, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, PNG = argv[0], argv[1]
SIZE = int(argv[2]) if len(argv) > 2 else 1024

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
assert gun.data.uv_layers, "GLB has no UV layer — unwrap upstream first"

mat = bpy.data.materials.new("aobake")
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
def node(t, x, y):
    n = nt.nodes.new(t)
    n.location = (x, y)
    return n

out = node('ShaderNodeOutputMaterial', 600, 0)
ao = node('ShaderNodeAmbientOcclusion', -200, 100)
ao.inputs['Distance'].default_value = 0.5
# Same floor the runtime bake uses — crevices go dark, never black.
ramp = node('ShaderNodeValToRGB', 100, 100)
ramp.color_ramp.elements[0].color = (0.25, 0.25, 0.25, 1)
ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
nt.links.new(ao.outputs['Color'], ramp.inputs[0])
nt.links.new(ramp.outputs[0], out.inputs['Surface'])

gun.data.materials.clear()
gun.data.materials.append(mat)
img = bpy.data.images.new("AO_OUT", SIZE, SIZE)
img.colorspace_settings.name = 'Non-Color'
inode = node('ShaderNodeTexImage', 350, -150)
inode.image = img
inode.select = True
nt.nodes.active = inode

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 96
sc.render.bake.margin = 16

for o in bpy.context.view_layer.objects:
    o.select_set(False)
gun.select_set(True)
bpy.context.view_layer.objects.active = gun
bpy.ops.object.bake(type='EMIT', use_clear=True)
img.save_render(PNG)
print("AO_BAKED", PNG)
