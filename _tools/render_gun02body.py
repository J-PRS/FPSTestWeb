import bpy, os, sys, math

d = os.path.dirname(bpy.data.filepath)
OG = os.path.join(d, "gun02_albedo.png")
GEN = os.path.join(d, "gen_gun02body.png")

# join meshes (link stray objects into view layer first)
sc_col = bpy.context.scene.collection
meshes = []
for o in bpy.data.objects:
    if o.type != 'MESH' or o.name != 'gGUN02_body': continue
    if o.name not in bpy.context.view_layer.objects:
        sc_col.objects.link(o)
    meshes.append(o)
bpy.ops.object.select_all(action='DESELECT')
for o in meshes: o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1: bpy.ops.object.join()
tgt = bpy.context.view_layer.objects.active

def set_tex(path):
    mat = bpy.data.materials.new("albedo")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs['Roughness'].default_value = 0.45
    bsdf.inputs['Metallic'].default_value = 0.85
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(path, check_existing=False)
    tex.image.colorspace_settings.name = 'sRGB'
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    tgt.data.materials.clear()
    tgt.data.materials.append(mat)

# frame the object
bb = [tgt.matrix_world @ __import__('mathutils').Vector(c) for c in tgt.bound_box]
cx = sum(v.x for v in bb)/8; cy = sum(v.y for v in bb)/8; cz = sum(v.z for v in bb)/8
size = max(max(v.x for v in bb)-min(v.x for v in bb),
           max(v.y for v in bb)-min(v.y for v in bb),
           max(v.z for v in bb)-min(v.z for v in bb))
cam_data = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cam_data)
sc_col.objects.link(cam)
cam.location = (cx + size*1.6, cy - size*1.6, cz + size*0.9)
direc = __import__('mathutils').Vector((cx,cy,cz)) - cam.location
cam.rotation_euler = direc.to_track_quat('-Z','Y').to_euler()
cam_data.clip_start = 0.01; cam_data.clip_end = size*100
bpy.context.scene.camera = cam

light_data = bpy.data.lights.new("key", 'SUN'); light_data.energy = 4.0
light = bpy.data.objects.new("key", light_data); sc_col.objects.link(light)
light.rotation_euler = (math.radians(50), 0, math.radians(30))
light2_data = bpy.data.lights.new("fill", 'SUN'); light2_data.energy = 1.5
light2 = bpy.data.objects.new("fill", light2_data); sc_col.objects.link(light2)
light2.rotation_euler = (math.radians(-30), 0, math.radians(-120))

w = bpy.context.scene.world
w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.03,0.03,0.035,1)
w.node_tree.nodes['Background'].inputs[1].default_value = 0.6

sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = sc.render.resolution_y = 1024
sc.render.image_settings.file_format = 'PNG'

sc.view_settings.exposure = 2.0

for tag, path in (("og", OG), ("gen", GEN)):
    set_tex(path)
    sc.render.filepath = os.path.join(d, f"side_{tag}.png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", tag)
