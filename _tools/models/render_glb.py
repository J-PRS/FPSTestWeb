import bpy, sys, math
import mathutils

argv = sys.argv[sys.argv.index('--') + 1:]
glb_path, out_prefix = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb_path)

mins = mathutils.Vector((1e9,) * 3)
maxs = mathutils.Vector((-1e9,) * 3)
for o in bpy.context.scene.objects:
    if o.type == 'MESH':
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            mins = mathutils.Vector(map(min, mins, w))
            maxs = mathutils.Vector(map(max, maxs, w))
center = (mins + maxs) / 2
size = (maxs - mins).length
dist = size * 1.4

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam
cam.data.lens = 60

sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 4
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
bpy.context.scene.collection.objects.link(sun)

world = bpy.data.worlds.new('w')
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs[0].default_value = (0.15, 0.17, 0.2, 1)
bg.inputs[1].default_value = 0.6
bpy.context.scene.world = world

sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = sc.render.resolution_y = 640

for i, az in enumerate([20, 90, 210]):
    azr = math.radians(az)
    el = math.radians(10)
    cam.location = (center.x + dist * math.sin(azr) * math.cos(el),
                    center.y - dist * math.cos(azr) * math.cos(el),
                    center.z + dist * math.sin(el))
    d = cam.location - mathutils.Vector(center)
    cam.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    sc.render.filepath = f'{out_prefix}_{i}.png'
    bpy.ops.render.render(write_still=True)
    print('wrote', sc.render.filepath)
