import bpy, os

d = os.path.dirname(bpy.data.filepath)
OUT = os.path.join(d, "gen_albedo_baked.png")
TEX03 = os.path.join(d, "tex-03.jpg")

sc_col = bpy.context.scene.collection
meshes = []
for o in bpy.data.objects:
    if o.type != 'MESH': continue
    if o.name not in bpy.context.view_layer.objects:
        sc_col.objects.link(o)
    meshes.append(o)
bpy.ops.object.select_all(action='DESELECT')
for o in meshes: o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1: bpy.ops.object.join()
tgt = bpy.context.view_layer.objects.active

mat = bpy.data.materials.new("wearbake")
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()

def node(t, x, y):
    n = nt.nodes.new(t); n.location = (x, y); return n

out = node('ShaderNodeOutputMaterial', 1100, 300)
bevA = node('ShaderNodeBevel', -900, 500)
bevA.inputs['Radius'].default_value = 0.05
tex = node('ShaderNodeTexImage', -900, 150)
tex.image = bpy.data.images.load(TEX03, check_existing=False)
tex.image.filepath = TEX03; tex.image.reload()
mult = node('ShaderNodeMath', -650, 250); mult.operation = 'MULTIPLY'
mult.inputs[1].default_value = 0.2
bevB = node('ShaderNodeBevel', -400, 500)
diff = node('ShaderNodeMixRGB', -100, 550); diff.blend_type = 'DIFFERENCE'
ramp = node('ShaderNodeValToRGB', 150, 550)
ramp.color_ramp.elements[0].position = 0.1
ramp.color_ramp.elements[0].color = (0,0,0,1)
ramp.color_ramp.elements[1].position = 0.3
ramp.color_ramp.elements[1].color = (1,1,1,1)

# AO cavity darkening
ao = node('ShaderNodeAmbientOcclusion', -100, -150)
ao.inputs['Distance'].default_value = 1.0
aoramp = node('ShaderNodeValToRGB', 150, -150)
aoramp.color_ramp.elements[0].position = 0.55
aoramp.color_ramp.elements[0].color = (0.35,0.35,0.35,1)
aoramp.color_ramp.elements[1].position = 1.0
aoramp.color_ramp.elements[1].color = (1,1,1,1)

# grunge multiply: tex-03 through a gentle ramp so flats keep ~85-100% tone
gramp = node('ShaderNodeValToRGB', -400, -350)
gramp.color_ramp.elements[0].position = 0.2
gramp.color_ramp.elements[0].color = (0.72,0.72,0.72,1)
gramp.color_ramp.elements[1].position = 0.9
gramp.color_ramp.elements[1].color = (1,1,1,1)

# base metal tone (sampled dark brown-grey of bolt_v3)
base = node('ShaderNodeRGB', -100, 50)
base.outputs[0].default_value = (0.235,0.204,0.188,1)

mix1 = node('ShaderNodeMixRGB', 400, 50); mix1.blend_type='MULTIPLY'; mix1.inputs[0].default_value=1.0
mix2 = node('ShaderNodeMixRGB', 620, 50); mix2.blend_type='MULTIPLY'; mix2.inputs[0].default_value=1.0
worn = node('ShaderNodeRGB', 400, 450)
worn.outputs[0].default_value = (0.72,0.70,0.68,1)
mix3 = node('ShaderNodeMixRGB', 850, 200)

nt.links.new(tex.outputs['Color'], mult.inputs[0])
nt.links.new(mult.outputs[0], bevB.inputs['Radius'])
nt.links.new(bevA.outputs['Normal'], diff.inputs[1])
nt.links.new(bevB.outputs['Normal'], diff.inputs[2])
nt.links.new(diff.outputs[0], ramp.inputs[0])
nt.links.new(tex.outputs['Color'], gramp.inputs[0])
nt.links.new(base.outputs[0], mix1.inputs[1])
nt.links.new(gramp.outputs[0], mix1.inputs[2])
nt.links.new(ao.outputs['Color'], aoramp.inputs[0])
nt.links.new(mix1.outputs[0], mix2.inputs[1])
nt.links.new(aoramp.outputs[0], mix2.inputs[2])
nt.links.new(ramp.outputs[0], mix3.inputs[0])
nt.links.new(mix2.outputs[0], mix3.inputs[1])
nt.links.new(worn.outputs[0], mix3.inputs[2])
nt.links.new(mix3.outputs[0], out.inputs['Surface'])

tgt.data.materials.clear()
tgt.data.materials.append(mat)

img = bpy.data.images.new("BAKE_OUT", 2048, 2048)
img.colorspace_settings.name = 'Non-Color'
inode = node('ShaderNodeTexImage', 850, -100)
inode.image = img
inode.select = True
nt.nodes.active = inode

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 128
sc.render.bake.margin = 16

bpy.ops.object.bake(type='EMIT', use_clear=True)
img.save_render(OUT)
print("BAKED", OUT)
