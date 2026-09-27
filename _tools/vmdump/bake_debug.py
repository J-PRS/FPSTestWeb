import bpy, sys
argv = sys.argv[sys.argv.index('--') + 1:]
src, out_prefix = argv
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
for o in meshes: o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1: bpy.ops.object.join()
obj = bpy.context.active_object
obj.data.materials.clear()
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
bpy.ops.object.mode_set(mode='OBJECT')
mat = bpy.data.materials.new('b'); mat.use_nodes = True
nt = mat.node_tree; nt.nodes.clear()
outn = nt.nodes.new('ShaderNodeOutputMaterial')
emit = nt.nodes.new('ShaderNodeEmission')
geo = nt.nodes.new('ShaderNodeNewGeometry')
nt.links.new(geo.outputs['Pointiness'], emit.inputs['Color'])
nt.links.new(emit.outputs[0], outn.inputs[0])
obj.data.materials.append(mat)
img = bpy.data.images.new('dbg', 512, 512)
img.colorspace_settings.name = 'Non-Color'
tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = img
nt.nodes.active = tn; tn.select = True
sc = bpy.context.scene; sc.render.engine = 'CYCLES'
sc.render.bake.margin = 8
bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True)
bpy.context.view_layer.objects.active = obj
bpy.ops.object.bake(type='EMIT')
import os; img.filepath_raw = os.path.abspath(out_prefix + "_point.png"); img.file_format = 'PNG'
if img.is_dirty: img.save()
else: img.save_render(img.filepath_raw)
print('DONE')
