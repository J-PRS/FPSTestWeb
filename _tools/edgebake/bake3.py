# Weapon wear baker — emits all three maps per model in one headless run:
#   <name>_grime.png     full material output (broad dirt/grime response)
#   <name>_edge.png      Difference -> ColorRamp branch (thick edge bands)
#   <name>_edge_thin.png texture-baker curvature wear mask (thin lines)
# Sources: a .blend (bakes its own meshes on the authored UV) or a .glb
# (imports, smooth-by-angle so the ramp doesn't flood, same bakes + tb).
# Usage: blender -b <bakery.blend> --python bake3.py -- <model> <outdir> [res]
import bpy, sys, os, subprocess
import numpy as np
argv = sys.argv[sys.argv.index('--')+1:]
src_path, out_dir = argv[0], argv[1]
res = int(argv[2]) if len(argv) > 2 else 2048
name = os.path.splitext(os.path.basename(src_path))[0].replace('_baked','')
TB = os.path.join(os.path.dirname(__file__), '..', 'vmdump', '.tb', 'bin', 'texture-baker.exe')

if src_path.lower().endswith('.glb'):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=src_path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    try: bpy.ops.object.shade_smooth_by_angle(angle=0.52)
    except Exception: bpy.ops.object.shade_smooth()
else:
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]

src = bpy.data.materials.get('Material')
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.render.bake.margin = 16

def emit(imgname, mat):
    for o in meshes:
        o.data.materials.clear(); o.data.materials.append(mat)
        if o.data.uv_layers: o.data.uv_layers.active_index = 0
    img = bpy.data.images.new(imgname, width=res, height=res)
    tex = mat.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = img
    mat.node_tree.nodes.active = tex
    bpy.ops.object.bake(type='EMIT')
    img.filepath_raw = os.path.join(out_dir, imgname + '.png'); img.file_format='PNG'; img.save()
    bpy.data.images.remove(img)
    print("BAKED", imgname)

# grime: untouched material
emit(name + '_grime', src)

# thick edge: ramp branch isolated on a material copy
me = src.copy(); me.name = name + '_thick'
outp = [n for n in me.node_tree.nodes if n.bl_idname == 'ShaderNodeOutputMaterial'][0]
ramp = me.node_tree.nodes.get('Color Ramp')
for l in list(me.node_tree.links):
    if l.to_node == outp: me.node_tree.links.remove(l)
me.node_tree.links.new(ramp.outputs['Color'], outp.inputs['Surface'])
emit(name + '_edge', me)
bpy.data.materials.remove(me)

# thin edge: texture-baker curvature on the authored-UV export -> wear mask
uv_glb = os.path.join(out_dir, name + '_uv.glb')
bpy.ops.object.select_all(action='DESELECT')
for o in meshes: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=uv_glb, export_format='GLB',
                          use_selection=True, export_apply=True, export_yup=True)
subprocess.run([TB, '--lowpoly', uv_glb, '--output', out_dir,
                '--prefix', name + '_tb', '--width', str(res), '--height', str(res),
                '--aa', '2', '--thickness', '--world-normal',
                '--no-normal', '--no-position'], check=True, capture_output=True)
cv = np.flipud(np.array(bpy.data.images.load(os.path.join(out_dir, name + '_tb_curvature.png')).pixels[:],
                        dtype=np.float32).reshape(res, res, 4)[:, :, 0])
convex = np.clip((cv - 0.5) * 8.0, 0, 1)
def grow(p, n):
    for _ in range(n):
        p = np.maximum.reduce([p, np.roll(p,1,0), np.roll(p,-1,0), np.roll(p,1,1), np.roll(p,-1,1)])
    return p
def blur(p, n, s=1):
    for _ in range(n):
        p = (p + np.roll(p,s,0) + np.roll(p,-s,0) + np.roll(p,s,1) + np.roll(p,-s,1)) / 5
    return p
base = blur(grow(np.clip(convex * 1.4, 0, 0.9), 3), 1); base = np.clip(base * 1.5, 0, 0.85)
wide = blur(grow(convex.copy(), 10), 4)
pm = np.clip((blur(np.random.default_rng(11).random((res,res), dtype=np.float32), 6, 6) - 0.42) * 2.2, 0, 1)
pm2 = blur(np.random.default_rng(23).random((res,res), dtype=np.float32), 3, 3)
pm = np.clip(pm * (pm2 * 1.6 - 0.3), 0, 1)
em = np.clip(base + wide * pm * 1.3, 0, 1)
g = np.flipud(em)
gim = bpy.data.images.new(name + '_edge_thin', width=res, height=res, alpha=False)
px4 = np.repeat(g[:, :, None], 4, axis=2); px4[:, :, 3] = 1.0
gim.pixels[:] = px4.ravel(); gim.update()
gim.filepath_raw = os.path.join(out_dir, name + '_edge_thin.png')
gim.file_format = 'PNG'; gim.save()
print("BAKED", name + '_edge_thin')
