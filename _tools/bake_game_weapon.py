import bpy, os, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--")+1:]
GLB, OUTDIR = argv[0], argv[1]
TEX03 = r"C:\TEMP\_WEB\FPSWebTest\_tools\tex-03.jpg"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
sc_col = bpy.context.scene.collection

meshes = [o for o in bpy.data.objects if o.type=='MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in meshes: o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes)>1: bpy.ops.object.join()
og = bpy.context.view_layer.objects.active
og.name = "OG"

# duplicate for the baked variant
gen = og.copy(); gen.data = og.data.copy()
sc_col.objects.link(gen); gen.name = "GEN"

bb=[og.matrix_world @ Vector(c) for c in og.bound_box]
cx=sum(v.x for v in bb)/8; cy=sum(v.y for v in bb)/8; cz=sum(v.z for v in bb)/8
size=max(max(v.x for v in bb)-min(v.x for v in bb),max(v.y for v in bb)-min(v.y for v in bb),max(v.z for v in bb)-min(v.z for v in bb))
sep = size*0.9
gen.location.x += sep/2; og.location.x -= sep/2

# bake material on GEN (same node recipe as Unity bolt)
mat = bpy.data.materials.new("wearbake"); mat.use_nodes=True
nt = mat.node_tree; nt.nodes.clear()
def node(t,x,y):
    n=nt.nodes.new(t); n.location=(x,y); return n
out = node('ShaderNodeOutputMaterial',1100,300)
bevA = node('ShaderNodeBevel',-900,500); bevA.inputs['Radius'].default_value=0.05
tex = node('ShaderNodeTexImage',-900,150)
tex.image = bpy.data.images.load(TEX03)
mult = node('ShaderNodeMath',-650,250); mult.operation='MULTIPLY'; mult.inputs[1].default_value=0.2
bevB = node('ShaderNodeBevel',-400,500)
diff = node('ShaderNodeMixRGB',-100,550); diff.blend_type='DIFFERENCE'
ramp = node('ShaderNodeValToRGB',150,550)
ramp.color_ramp.elements[0].position=0.1; ramp.color_ramp.elements[0].color=(0,0,0,1)
ramp.color_ramp.elements[1].position=0.3; ramp.color_ramp.elements[1].color=(1,1,1,1)
ao = node('ShaderNodeAmbientOcclusion',-100,-150); ao.inputs['Distance'].default_value=1.0
aoramp = node('ShaderNodeValToRGB',150,-150)
aoramp.color_ramp.elements[0].position=0.55; aoramp.color_ramp.elements[0].color=(0.35,0.35,0.35,1)
aoramp.color_ramp.elements[1].position=1.0; aoramp.color_ramp.elements[1].color=(1,1,1,1)
gramp = node('ShaderNodeValToRGB',-400,-350)
gramp.color_ramp.elements[0].position=0.2; gramp.color_ramp.elements[0].color=(0.72,0.72,0.72,1)
gramp.color_ramp.elements[1].position=0.9; gramp.color_ramp.elements[1].color=(1,1,1,1)
base = node('ShaderNodeRGB',-100,50); base.outputs[0].default_value=(0.235,0.204,0.188,1)
mix1 = node('ShaderNodeMixRGB',400,50); mix1.blend_type='MULTIPLY'; mix1.inputs[0].default_value=1.0
mix2 = node('ShaderNodeMixRGB',620,50); mix2.blend_type='MULTIPLY'; mix2.inputs[0].default_value=1.0
worn = node('ShaderNodeRGB',400,450); worn.outputs[0].default_value=(0.72,0.70,0.68,1)
mix3 = node('ShaderNodeMixRGB',850,200)
nt.links.new(tex.outputs['Color'],mult.inputs[0])
nt.links.new(mult.outputs[0],bevB.inputs['Radius'])
nt.links.new(bevA.outputs['Normal'],diff.inputs[1])
nt.links.new(bevB.outputs['Normal'],diff.inputs[2])
nt.links.new(diff.outputs[0],ramp.inputs[0])
nt.links.new(tex.outputs['Color'],gramp.inputs[0])
nt.links.new(base.outputs[0],mix1.inputs[1])
nt.links.new(gramp.outputs[0],mix1.inputs[2])
nt.links.new(ao.outputs['Color'],aoramp.inputs[0])
nt.links.new(mix1.outputs[0],mix2.inputs[1])
nt.links.new(aoramp.outputs[0],mix2.inputs[2])
nt.links.new(ramp.outputs[0],mix3.inputs[0])
nt.links.new(mix2.outputs[0],mix3.inputs[1])
nt.links.new(worn.outputs[0],mix3.inputs[2])
nt.links.new(mix3.outputs[0],out.inputs['Surface'])

gen.data.materials.clear(); gen.data.materials.append(mat)
img = bpy.data.images.new("BAKE_OUT",1024,1024); img.colorspace_settings.name='Non-Color'
inode = node('ShaderNodeTexImage',850,-100); inode.image=img; inode.select=True; nt.nodes.active=inode

sc=bpy.context.scene
sc.render.engine='CYCLES'; sc.cycles.device='CPU'; sc.cycles.samples=96
sc.render.bake.margin=16

for o in bpy.context.view_layer.objects: o.select_set(False)
gen.select_set(True); bpy.context.view_layer.objects.active=gen
bpy.ops.object.bake(type='EMIT', use_clear=True)
PNG = os.path.join(OUTDIR,"w0_gen_albedo.png")
img.save_render(PNG)
print("BAKED",PNG)

# re-material GEN with the baked texture for the render
mat2 = bpy.data.materials.new("genfinal"); mat2.use_nodes=True
nt2 = mat2.node_tree; nt2.nodes.clear()
out2=nt2.nodes.new('ShaderNodeOutputMaterial')
bs=nt2.nodes.new('ShaderNodeBsdfPrincipled')
tx=nt2.nodes.new('ShaderNodeTexImage'); tx.image=bpy.data.images.load(PNG)
bs.inputs['Metallic'].default_value=0.85; bs.inputs['Roughness'].default_value=0.45
nt2.links.new(tx.outputs['Color'],bs.inputs['Base Color']); nt2.links.new(bs.outputs[0],out2.inputs['Surface'])
gen.data.materials.clear(); gen.data.materials.append(mat2)

# OG gets a plain gunmetal principled (flat — what it looks like untextured)
ogmat = bpy.data.materials.new("ogflat"); ogmat.use_nodes=True
pb = ogmat.node_tree.nodes.get('Principled BSDF')
pb.inputs['Base Color'].default_value=(0.235,0.204,0.188,1)
pb.inputs['Metallic'].default_value=0.85; pb.inputs['Roughness'].default_value=0.45
og.data.materials.clear(); og.data.materials.append(ogmat)

# camera + lights
cd=bpy.data.cameras.new("c"); cam=bpy.data.objects.new("c",cd); sc_col.objects.link(cam)
cam.location=(cx+size*1.5, cy-size*1.5, cz+size*0.7)
cam.rotation_euler=(Vector((cx,cy,cz))-cam.location).to_track_quat('-Z','Y').to_euler()
cd.clip_start=0.001; cd.clip_end=size*100
sc.camera=cam
for nm,e,rot in [("k",4,(math.radians(50),0,math.radians(30))),("f",1.5,(math.radians(-30),0,math.radians(-120)))]:
    ld=bpy.data.lights.new(nm,'SUN'); ld.energy=e
    l=bpy.data.objects.new(nm,ld); sc_col.objects.link(l); l.rotation_euler=rot
w=bpy.data.worlds.new('w'); sc.world=w; w.use_nodes=True
w.node_tree.nodes['Background'].inputs[0].default_value=(0.05,0.05,0.06,1)
w.node_tree.nodes['Background'].inputs[1].default_value=0.6
sc.render.engine='BLENDER_EEVEE'
sc.render.resolution_x=sc.render.resolution_y=1024
sc.render.image_settings.file_format='PNG'
sc.view_settings.look='AgX - Medium High Contrast'; sc.view_settings.exposure=1.5
sc.render.filepath=os.path.join(OUTDIR,"w0_sidebyside.png")
bpy.ops.render.render(write_still=True)
print("DONE")
