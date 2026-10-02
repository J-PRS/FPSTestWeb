"""Bake test: reuse launcher.blend's 'Material' bake rig on a new mesh.
Run: blender -b launcher.blend --python bake_test.py -- <out.png>
Appends a Suzanne, UV-unwraps, assigns Material, adds a bake-target
image node (the active image node is where Cycles writes the bake),
bakes EMIT at 512 and saves."""
import bpy
import sys

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else r'C:\TEMP\_WEB\FPSWebTest\_tools\bake_test.png'

mat = bpy.data.materials.get('Material')
assert mat and mat.use_nodes, 'bake material not found'

# Fresh target mesh
bpy.ops.mesh.primitive_monkey_add(location=(0, 0, 3))
obj = bpy.context.active_object
obj.name = 'BakeTest'
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
bpy.ops.object.mode_set(mode='OBJECT')

# Assign the bake rig
obj.data.materials.clear()
obj.data.materials.append(mat)

# Bake target: Cycles writes into the material's ACTIVE image node —
# add one per material slot... there's one slot, shared material:
# the node must live in the shared tree, active-selected.
img = bpy.data.images.new('BAKE_TARGET', width=512, height=512)
nt = mat.node_tree
tex_node = nt.nodes.new('ShaderNodeTexImage')
tex_node.image = img
for n in nt.nodes:
    n.select = False
tex_node.select = True
nt.nodes.active = tex_node

# Scene + engine
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.cycles.device = 'CPU'
scene.render.bake.margin = 8
bpy.context.view_layer.objects.active = obj
obj.select_set(True)

bpy.ops.object.bake(type='EMIT')
img.save_render(OUT)
img.pack()  # embed the bake in the .blend so it survives without the png
print(f'===== BAKED -> {OUT} =====')

SAVE = argv[1] if len(argv) > 1 else None
if SAVE:
    bpy.ops.wm.save_as_mainfile(filepath=SAVE)
    print(f'===== SAVED -> {SAVE} =====')
