# Blender headless weapon bake: blender -b --python bake.py -- in.glb out_prefix
# Joins meshes → smart UV atlas → bakes a custom Emission shader to PNG:
#   shade = vertex color * (AO crevice darkening + Pointiness edge wear + noise mottle)
# Re-exports the UV-mapped mesh as <prefix>_baked.glb beside <prefix>_ao.png.
import bpy, sys, os

argv = sys.argv[sys.argv.index('--') + 1:]
src, out_prefix = argv

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
assert meshes, 'no meshes in ' + src
# The chaingun barrel triad spins at runtime — it must stay its own node in
# the baked GLB, so it skips the join and gets a separate small bake below.
# The 'barrels' name sits on the glTF group node; its mesh children may
# import unnamed, so collect descendants of that node too.
broot = next((o for o in bpy.context.scene.objects if 'barrels' in o.name.lower()), None)
def _kids(o):
    for c in o.children:
        yield c
        yield from _kids(c)
barrels = [o for o in ([broot] + list(_kids(broot)) if broot else [])
           if o.type == 'MESH']
meshes = [o for o in meshes if o not in barrels]
assert meshes, 'only barrels in ' + src
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.active_object
obj.data.materials.clear()

# The GLB carries one COLOR_n attribute per original part; joining the mesh
# keeps them all and leaves other verts white-filled. Merge them into a
# single PARTCOL layer: per element, take the component-wise MIN so real
# part paint (always <1) wins over white fill.
import numpy as np
mesh = obj.data
attrs = [a for a in mesh.color_attributes]
if len(attrs) > 1:
    dom, typ = attrs[0].domain, attrs[0].data_type
    n = len(attrs[0].data)
    merged = np.ones((n, 4), dtype=np.float32)
    for a in attrs:
        v = np.empty(n * 4, dtype=np.float32)
        a.data.foreach_get('color', v)
        merged = np.minimum(merged, v.reshape(-1, 4))
    for a in attrs:
        mesh.color_attributes.remove(a)
    ca = mesh.color_attributes.new(name='PARTCOL', type=typ, domain=dom)
    ca.data.foreach_set('color', merged.ravel())
    print('DBG merged col mean/p10:', float(merged.mean()), float(np.percentile(merged, 10)))
else:
    print('DBG single color attr:', attrs[0].name if attrs else 'NONE', 'n=', len(attrs))

# --- UV atlas ---
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
bpy.ops.object.mode_set(mode='OBJECT')

# texture-baker needs UVs to exist — export the unwrapped mesh and let it
# produce real mesh maps (raycast AO, mesh curvature, thickness, world normal).
import subprocess
uv_glb = os.path.abspath(out_prefix + '_uv.glb')
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=uv_glb, export_format='GLB',
                          use_selection=True, export_apply=True, export_yup=True)
tb = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                  '.tb', 'bin', 'texture-baker.exe')
tbout = os.path.abspath(os.path.dirname(out_prefix))
subprocess.run([tb, '--lowpoly', uv_glb, '--output', tbout,
                '--prefix', os.path.basename(out_prefix) + '_tb',
                '--width', '1024', '--height', '1024', '--aa', '2',
                '--thickness', '--world-normal',
                '--no-normal', '--no-position'],
               check=True, capture_output=True)

# --- Bake material: emission = vertexColor * (ao + wear + mottle) ---
mat = bpy.data.materials.new('bake')
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
N, L = nt.nodes.new, nt.links.new
outn = N('ShaderNodeOutputMaterial')
emit = N('ShaderNodeEmission')
ao = N('ShaderNodeAmbientOcclusion')
if 'Distance' in ao.inputs: ao.inputs['Distance'].default_value = 0.12
if 'Samples' in ao.inputs: ao.inputs['Samples'].default_value = 48
geo = N('ShaderNodeNewGeometry')
noise = N('ShaderNodeTexNoise')
noise.inputs['Scale'].default_value = 18.0
noise.inputs['Detail'].default_value = 5.0
noise.inputs['Roughness'].default_value = 0.7

# crevice shading: 0.3..1.0 from AO
aoRamp = N('ShaderNodeValToRGB')
aoRamp.color_ramp.elements[0].color = (0.3, 0.3, 0.3, 1)
aoRamp.color_ramp.elements[1].color = (1, 1, 1, 1)
L(ao.outputs['AO'], aoRamp.inputs['Fac'])

# Stains: low-freq blotchy variation like grime pooling — +-22%
stain = N('ShaderNodeTexNoise')
stain.inputs['Scale'].default_value = 3.5
stain.inputs['Detail'].default_value = 3.0
stain.inputs['Roughness'].default_value = 0.75
stainMul = N('ShaderNodeMath'); stainMul.operation = 'MULTIPLY_ADD'
L(stain.outputs['Fac'], stainMul.inputs[0])
stainMul.inputs[1].default_value = 0.44
stainMul.inputs[2].default_value = 0.78

# mottle: mid-freq patchiness +-16%
motMul = N('ShaderNodeMath'); motMul.operation = 'MULTIPLY_ADD'
L(noise.outputs['Fac'], motMul.inputs[0])
motMul.inputs[1].default_value = 0.32
motMul.inputs[2].default_value = 0.84

# Grain: fine per-texel grain like cast/brushed metal — +-12%
grain = N('ShaderNodeTexNoise')
grain.inputs['Scale'].default_value = 220.0
grain.inputs['Detail'].default_value = 2.0
grain.inputs['Roughness'].default_value = 0.8
grainMul = N('ShaderNodeMath'); grainMul.operation = 'MULTIPLY_ADD'
L(grain.outputs['Fac'], grainMul.inputs[0])
grainMul.inputs[1].default_value = 0.24
grainMul.inputs[2].default_value = 0.88

motAll = N('ShaderNodeMath'); motAll.operation = 'MULTIPLY'
L(motMul.outputs[0], motAll.inputs[0])
L(stainMul.outputs[0], motAll.inputs[1])
motAll2 = N('ShaderNodeMath'); motAll2.operation = 'MULTIPLY'
L(motAll.outputs[0], motAll2.inputs[0])
L(grainMul.outputs[0], motAll2.inputs[1])

shadeAll = N('ShaderNodeMath'); shadeAll.operation = 'MULTIPLY'
L(aoRamp.outputs['Color'], shadeAll.inputs[0])
L(motAll2.outputs[0], shadeAll.inputs[1])

# vertex color (part paint) * shading
colAttr = N('ShaderNodeVertexColor')
if mesh.color_attributes:
    colAttr.layer_name = mesh.color_attributes[0].name
shadeMul = N('ShaderNodeMixRGB'); shadeMul.blend_type = 'MULTIPLY'
shadeMul.inputs[0].default_value = 1.0
L(colAttr.outputs['Color'], shadeMul.inputs[1])
L(shadeAll.outputs[0], shadeMul.inputs[2])
L(shadeMul.outputs['Color'], emit.inputs['Color'])
L(emit.outputs[0], outn.inputs[0])
obj.data.materials.append(mat)

# --- Bake target ---
img = bpy.data.images.new('bake_out', width=1024, height=1024)
img.colorspace_settings.name = 'Non-Color'
texNode = nt.nodes.new('ShaderNodeTexImage')
texNode.image = img
nt.nodes.active = texNode
texNode.select = True

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 32
sc.cycles.use_denoising = True
sc.render.bake.margin = 16
sc.render.bake.use_clear = True
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
bpy.ops.object.bake(type='EMIT')
png = os.path.abspath(out_prefix + '_ao.png')
img.filepath_raw = png
img.file_format = 'PNG'
if img.is_dirty:
    img.save()
else:
    img.save_render(png)  # some bakes mark the image clean but unsaved

# --- Composite with real mesh maps from texture-baker ---
import numpy as np
H, W = 1024, 1024
def px(im):
    a = np.array(im.pixels[:], dtype=np.float32).reshape(-1, 4)
    return a[:, :3].copy()
def tbpng(name):
    im = bpy.data.images.load(os.path.join(tbout, name), check_existing=True)
    a = np.array(im.pixels[:], dtype=np.float32).reshape(H, W, 4)
    return np.flipud(a[:, :, 0])  # glTF UV origin is top-left; Blender pixels bottom-up
emit_px = px(img)
ao2 = tbpng(os.path.basename(out_prefix) + '_tb_ao.png')
cv = tbpng(os.path.basename(out_prefix) + '_tb_curvature.png')
wn = bpy.data.images.load(os.path.join(tbout, os.path.basename(out_prefix) + '_tb_world_normal.png'), check_existing=True)
wnz = np.flipud(np.array(wn.pixels[:], dtype=np.float32).reshape(H, W, 4)[:, :, 1])  # glTF Y-up
print('DBG emit mean/p90:', float(emit_px.mean()), float(np.percentile(emit_px, 90)))
print('DBG ao/curv mean:', float(ao2.mean()), float(cv.mean()))

# True mesh curvature: 0.5 = flat, >0.5 convex (exposed edges → wear rims),
# <0.5 concave (creases → extra shadowing on top of AO).
convex = np.clip((cv - 0.5) * 8.0, 0, 1)
concave = np.clip((0.5 - cv) * 8.0, 0, 1)
# Two-layer wear: thin uniform rim on every convex edge + wider splotchy
# layer masked by low-freq noise so some edges wear harder.
base = np.clip(convex * 1.4, 0, 0.9)
core = convex.copy()
for _ in range(3):
    base = np.maximum.reduce([base, np.roll(base, 1, 0), np.roll(base, -1, 0), np.roll(base, 1, 1), np.roll(base, -1, 1)])
base = (base + np.roll(base, 1, 0) + np.roll(base, -1, 0) + np.roll(base, 1, 1) + np.roll(base, -1, 1)) / 5
# Cap base rims — small islands saturate edge-to-edge otherwise, wiping
# the wear into a flat sheet (w14 lathe showed this).
base = np.clip(base * 1.5, 0, 0.85)

wide = core.copy()
for _ in range(10):
    wide = np.maximum.reduce([wide, np.roll(wide, 1, 0), np.roll(wide, -1, 0), np.roll(wide, 1, 1), np.roll(wide, -1, 1)])
for _ in range(4):
    wide = (wide + np.roll(wide, 1, 0) + np.roll(wide, -1, 0) + np.roll(wide, 1, 1) + np.roll(wide, -1, 1)) / 5
# patch mask: low-freq noise decides which edges get the wide layer
rng = np.random.default_rng(11)
pm = rng.random((H, W), dtype=np.float32)
for _ in range(6):
    pm = (pm + np.roll(pm, 6, 0) + np.roll(pm, -6, 0) + np.roll(pm, 6, 1) + np.roll(pm, -6, 1)) / 5
pm = np.clip((pm - 0.42) * 2.2, 0, 1)
# second octave breaks the splotch up so wide wear isn't one blobby mask
pm2 = np.random.default_rng(23).random((H, W), dtype=np.float32)
for _ in range(3):
    pm2 = (pm2 + np.roll(pm2, 3, 0) + np.roll(pm2, -3, 0) + np.roll(pm2, 3, 1) + np.roll(pm2, -3, 1)) / 5
pm = np.clip(pm * (pm2 * 1.6 - 0.3), 0, 1)
em = np.clip(base + wide * pm * 1.3, 0, 1).reshape(-1)

# Normalize per-weapon median luminance to ~0.5 before shading — authored
# part colors range from near-black (railgun ~0.08) to mid-tan (cannon ~0.4),
# and ACES @ 0.4 exposure crushes anything starting below ~0.2 into void.
island = emit_px.max(axis=1) > 0.02
# Median of per-pixel luminance (mean RGB), not max-channel: a few blown
# islands skewed max-channel medians to 1.0 while the visible bulk sat dark.
med = float(np.median(emit_px[island].mean(axis=1))) if island.any() else 0.4
gain = np.clip(0.55 / max(med, 0.05), 0.6, 8.0)
emit_px = np.clip(emit_px * gain, 0, 1)
print('DBG norm med/gain:', med, float(gain))

# Real raycast AO: deeper + more accurate than the Cycles AO node (which the
# emit bake already carries at 32 samples — the two multiply fine, AO is
# multiplicative by nature). Concave curvature adds crease darkening.
emit_px = emit_px * (0.35 + 0.65 * ao2).reshape(-1, 1)
emit_px = emit_px * (1.0 - 0.30 * concave).reshape(-1, 1)

# Orientation layer: world-space normal Y = up/down facing. Up-facing
# surfaces catch dust (lighten), down-facing pool grime (darken).
nup = np.clip(wnz.reshape(-1) * 2.0 - 1.0, -1, 1)  # 0..1 nrm encodes -1..1
# Hand-painted gradient: warm light pooling up, cool shadow down — tinted,
# not neutral gray, so surfaces get directional warmth like the Unity refs.
dust = np.clip(nup, 0, 1)[:, None] * np.array([0.17, 0.15, 0.10])
grime = np.clip(-nup, 0, 1)[:, None] * np.array([0.13, 0.15, 0.20])

# brighten edges on anything but the darkest crevice pixels — weapon albedos
# are dark (~0.15-0.3) so the gate must sit below that, not at ~0.5.
lum = emit_px.max(axis=1)
wear = em * np.clip(lum * 6.0 - 0.1, 0, 1) * 1.6
out = np.clip(emit_px + dust - grime + wear[:, None] * (1.0 - emit_px), 0, 1)

# Standalone maps on the same atlas: _edge = the wear mask itself (thin rim +
# splotchy wide wear, before the composite), _grime = the AO/crease shading
# factor. The shader samples them separately from the baked albedo so the
# wear band stays tunable at runtime.
def dump_gray(name, plane):
    g = np.flipud(plane.reshape(H, W))
    gim = bpy.data.images.new(name, width=W, height=H, alpha=False)
    gim.colorspace_settings.name = 'Non-Color'
    px4 = np.repeat(g[:, :, None], 4, axis=2)
    px4[:, :, 3] = 1.0
    gim.pixels[:] = px4.ravel()
    gim.update()
    gim.filepath_raw = os.path.abspath(out_prefix + name + '.png')
    gim.file_format = 'PNG'
    gim.save()
    bpy.data.images.remove(gim)
dump_gray('_edge', em)
dump_gray('_grime', (0.35 + 0.65 * ao2) * (1.0 - 0.30 * concave))

# No speckle — JP's refs are smooth mottled metal; random flecks read as noise.

# Mild lift — the median normalization already lands us near mid-tone;
# this just offsets ACES crushing the bottom half.
out = np.clip(out * 1.35 + 0.04, 0, 1)

img.pixels[:] = np.concatenate([out, np.ones((len(out), 1), dtype=np.float32)], axis=1).ravel()
img.update()
img.save()
print('WROTE', png, img.size[0], 'x', img.size[1])

# --- Chaingun barrels: separate small bake so the triad stays a node ---
if barrels:
    bpy.ops.object.select_all(action='DESELECT')
    for o in barrels:
        o.select_set(True)
    bpy.context.view_layer.objects.active = barrels[0]
    if len(barrels) > 1:
        bpy.ops.object.join()
    bobj = bpy.context.active_object
    bmesh = bobj.data
    # merge the triad's color attrs into PARTCOL exactly like the body did
    battrs = [a for a in bmesh.color_attributes]
    if len(battrs) > 1:
        dom, typ = battrs[0].domain, battrs[0].data_type
        n = len(battrs[0].data)
        mrg = np.ones((n, 4), dtype=np.float32)
        for a in battrs:
            v = np.empty(n * 4, dtype=np.float32)
            a.data.foreach_get('color', v)
            mrg = np.minimum(mrg, v.reshape(-1, 4))
        for a in battrs:
            bmesh.color_attributes.remove(a)
        ca = bmesh.color_attributes.new(name='PARTCOL', type=typ, domain=dom)
        ca.data.foreach_set('color', mrg.ravel())
    bobj.data.materials.clear()
    bobj.data.materials.append(mat)
    # retarget the shared bake material's color input to this mesh's attr
    if bmesh.color_attributes:
        colAttr.layer_name = bmesh.color_attributes[0].name
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    img2 = bpy.data.images.new('bake_b', width=256, height=256)
    img2.colorspace_settings.name = 'Non-Color'
    texNode.image = img2
    bpy.ops.object.bake(type='EMIT')
    be = np.array(img2.pixels[:], dtype=np.float32).reshape(-1, 4)[:, :3].copy()
    bmask = be.max(axis=1) > 0.02
    bmed = float(np.median(be[bmask].mean(axis=1))) if bmask.any() else 0.4
    be = np.clip(be * np.clip(0.55 / max(bmed, 0.05), 0.6, 8.0), 0, 1)
    be = np.clip(be * 1.35 + 0.04, 0, 1)
    img2.pixels[:] = np.concatenate([be, np.ones((len(be), 1), dtype=np.float32)], axis=1).ravel()
    img2.update()
    bpng = os.path.abspath(out_prefix + 'b_ao.png')
    img2.filepath_raw = bpng
    img2.file_format = 'PNG'
    img2.save()
    bobj.name = 'barrels'  # runtime swap finds the spin node by this name
    print('WROTE', bpng)

# --- Re-export UV'd mesh(es) ---
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
if barrels:
    bobj.select_set(True)
bpy.ops.export_scene.gltf(filepath=out_prefix + '_baked.glb', export_format='GLB',
                          use_selection=True, export_materials='EXPORT')
print('BAKED', out_prefix)
