import bpy, os, sys

OUT = os.path.join(os.path.dirname(bpy.data.filepath), "recreated_gun02body.png")
TEX03 = os.path.join(os.path.dirname(bpy.data.filepath), "tex-03.jpg")

# join all mesh objects into one bake target, preserving UVs
# objects may live in collections excluded from the view layer — link them in
sc_col = bpy.context.scene.collection
meshes = []
for o in bpy.data.objects:
    if o.type != 'MESH' or o.name == 'Cube' or o.name != 'gGUN02_body': continue
    if o.name not in bpy.context.view_layer.objects:
        sc_col.objects.link(o)
    meshes.append(o)
bpy.ops.object.select_all(action='DESELECT')
for o in meshes: o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1: bpy.ops.object.join()
tgt = bpy.context.view_layer.objects.active
print("TARGET", tgt.name, "uvs:", [u.name for u in tgt.data.uv_layers])

# fresh material reproducing the launcher.blend bake chain
mat = bpy.data.materials.new("wearbake")
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()

def node(t, x, y, name=None):
    n = nt.nodes.new(t); n.location = (x, y)
    if name: n.name = name
    return n

out = node('ShaderNodeOutputMaterial', 800, 300)
bevA = node('ShaderNodeBevel', -900, 500)            # radius .05
bevA.inputs['Radius'].default_value = 0.05
tex = node('ShaderNodeTexImage', -900, 150)
tex.image = bpy.data.images.load(TEX03, check_existing=False)
tex.image.filepath = TEX03
tex.image.reload()
mult = node('ShaderNodeMath', -650, 250); mult.operation = 'MULTIPLY'
mult.inputs[1].default_value = 0.2
bevB = node('ShaderNodeBevel', -400, 500)            # radius driven by tex*.2
diff = node('ShaderNodeMixRGB', -100, 500); diff.blend_type = 'DIFFERENCE'
ramp = node('ShaderNodeValToRGB', 150, 500)
ramp.color_ramp.elements[0].position = 0.1
ramp.color_ramp.elements[0].color = (0,0,0,1)
ramp.color_ramp.elements[1].position = 0.3
ramp.color_ramp.elements[1].color = (1,1,1,1)
mix = node('ShaderNodeMixRGB', 400, 300)
mix.inputs[0].default_value = 0.5
mix.inputs[2].default_value = (0.0,0.0,0.0,1.0)      # base black B
gain = node('ShaderNodeMath', 600, 300); gain.operation = 'MULTIPLY'
gain.inputs[1].default_value = 2.0

nt.links.new(tex.outputs['Color'], mult.inputs[0])
nt.links.new(mult.outputs[0], bevB.inputs['Radius'])
nt.links.new(bevA.outputs['Normal'], diff.inputs[1])
nt.links.new(bevB.outputs['Normal'], diff.inputs[2])
nt.links.new(diff.outputs[0], ramp.inputs[0])
nt.links.new(ramp.outputs[0], mix.inputs[1])
nt.links.new(mix.outputs[0], gain.inputs[0])
nt.links.new(gain.outputs[0], out.inputs['Surface'])

tgt.data.materials.clear()
tgt.data.materials.append(mat)

# bake target image node (must be selected in the tree)
img = bpy.data.images.new("BAKE_OUT", 2048, 2048)
img.colorspace_settings.name = 'Non-Color'
inode = node('ShaderNodeTexImage', 400, -100)
inode.image = img
inode.select = True
nt.nodes.active = inode

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 64
sc.render.bake.margin = 16
sc.render.filepath = OUT

bpy.ops.object.bake(type='EMIT', use_clear=True)
img.save_render(OUT)
print("BAKED", OUT)
