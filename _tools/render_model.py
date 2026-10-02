import bpy, os, math
from mathutils import Vector
d = os.path.dirname(bpy.data.filepath)
sc_col = bpy.context.scene.collection
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in meshes:
    if o.name not in bpy.context.view_layer.objects:
        sc_col.objects.link(o)
bpy.ops.object.select_all(action='DESELECT')
for o in meshes: o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1: bpy.ops.object.join()
tgt = bpy.context.view_layer.objects.active
bb = [tgt.matrix_world @ Vector(c) for c in tgt.bound_box]
cx=sum(v.x for v in bb)/8; cy=sum(v.y for v in bb)/8; cz=sum(v.z for v in bb)/8
size=max(max(v.x for v in bb)-min(v.x for v in bb),max(v.y for v in bb)-min(v.y for v in bb),max(v.z for v in bb)-min(v.z for v in bb))
cd=bpy.data.cameras.new("c"); cam=bpy.data.objects.new("c",cd); sc_col.objects.link(cam)
cam.location=(cx+size*1.5,cy-size*1.5,cz+size*0.7)
direc=Vector((cx,cy,cz))-cam.location
cam.rotation_euler=direc.to_track_quat('-Z','Y').to_euler()
cd.clip_start=0.001; cd.clip_end=size*100
bpy.context.scene.camera=cam
ld=bpy.data.lights.new("k",'SUN'); ld.energy=4
l=bpy.data.objects.new("k",ld); sc_col.objects.link(l); l.rotation_euler=(math.radians(50),0,math.radians(30))
ld2=bpy.data.lights.new("f",'SUN'); ld2.energy=1.5
l2=bpy.data.objects.new("f",ld2); sc_col.objects.link(l2); l2.rotation_euler=(math.radians(-30),0,math.radians(-120))
w=bpy.context.scene.world; w.use_nodes=True
w.node_tree.nodes['Background'].inputs[0].default_value=(0.05,0.05,0.06,1)
w.node_tree.nodes['Background'].inputs[1].default_value=0.6
sc=bpy.context.scene
sc.render.engine='BLENDER_EEVEE'
sc.render.resolution_x=sc.render.resolution_y=900
sc.render.image_settings.file_format='PNG'
sc.view_settings.look='AgX - Medium High Contrast'
sc.view_settings.exposure=1.5
sc.render.filepath=os.path.join(d,"bolt_real_model.png")
bpy.ops.render.render(write_still=True)
print("OK")
