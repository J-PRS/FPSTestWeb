# Juggernaut "bld" — hand-modeled plate rig built in Blender, sourced
# from a .blend for progressive work. Rigid plates skinned 100% to one
# bone (armor articulates, doesn't stretch); skeleton + all clips are
# brute's, imported from class_brute.glb.
#
#   blender -b -P _tools/models/build_juggernaut_bld.py
#
# Outputs: _tools/models/juggernaut_bld.blend  (source of truth)
#          client/public/assets/models/class_juggernaut_bld.glb
import bpy, math, subprocess
from mathutils import Vector

ROOT = 'C:/TEMP/_WEB/FPSWebTest'
SRC = ROOT + '/client/public/assets/models/class_brute.glb'
OUT_GLB = ROOT + '/client/public/assets/models/class_juggernaut_bld.glb'
OUT_BLEND = ROOT + '/_tools/models/juggernaut_bld.blend'

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
# strip brute meshes — armature + actions stay, so every clip exports
for o in [o for o in bpy.data.objects if o.type == 'MESH']:
    bpy.data.objects.remove(o, do_unlink=True)

ARMOR = bpy.data.materials.new('armor'); ARMOR.diffuse_color = (0.32, 0.35, 0.38, 1)
DARK = bpy.data.materials.new('dark');   DARK.diffuse_color = (0.13, 0.14, 0.15, 1)
ACCENT = bpy.data.materials.new('accent'); ACCENT.diffuse_color = (0.6, 0.15, 0.1, 1)

# Authored frame is already Blender-frame (+X left, -Y front, +Z up) —
# the same coords the .mjs builder feeds its toGltf step, so identity.
def conv(p): return tuple(p)

def plate(name, verts, faces, bone, mat, bevel=0.03):
    me = bpy.data.meshes.new(name)
    me.from_pydata([conv(v) for v in verts], [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat)
    vg = ob.vertex_groups.new(name=bone)
    vg.add(range(len(me.vertices)), 1.0, 'REPLACE')
    mod = ob.modifiers.new('arm', 'ARMATURE'); mod.object = arm
    if bevel > 0:
        b = ob.modifiers.new('bev', 'BEVEL'); b.width = bevel; b.segments = 2
    ob.parent = arm
    return ob

def box8(c, h):
    x, y, z = c; hx, hy, hz = h
    return [(x+sx*hx, y+sy*hy, z+sz*hz) for sx in (-1,1) for sy in (-1,1) for sz in (-1,1)]

FACES6 = [(0,2,3,1),(4,5,7,6),(0,1,5,4),(2,6,7,3),(0,4,6,2),(1,3,7,5)]

def slab(name, c, h, bone, mat, bevel=0.03):
    return plate(name, box8(c, h), FACES6, bone, mat, bevel)

def cyl(name, c, r, h, bone, mat, n=8, bevel=0.02):
    x, y, z = c
    vs = [(x+math.cos(t)*r, y+h/2, z+math.sin(t)*r) for t in [i*2*math.pi/n for i in range(n)]]
    vs += [(x+math.cos(t)*r, y-h/2, z+math.sin(t)*r) for t in [i*2*math.pi/n for i in range(n)]]
    fs = [tuple(range(n-1, -1, -1)), tuple(range(n, 2*n))]
    for i in range(n):
        j = (i+1) % n
        fs.append((i, j, j+n, i+n))
    return plate(name, vs, fs, bone, mat, bevel)

def dome(name, c, r, bone, mat, segs=8, rings=4, bevel=0.02, squash=(1,1,1), span=0.62):
    # shell swept from pole down past the equator — span 0.5 = hemisphere,
    # 0.62 wraps below it so pauldrons read as bells, not caps.
    x, y, z = c
    vs, fs = [], []
    for ri in range(rings + 1):
        th = (ri / rings) * (math.pi * span)
        for si in range(segs):
            ph = (si / segs) * 2 * math.pi
            vs.append((x + math.sin(th)*math.cos(ph)*r*squash[0],
                       y + math.sin(th)*math.sin(ph)*r*squash[1],
                       z + math.cos(th)*r*squash[2]))
    for ri in range(rings):
        for si in range(segs):
            a = ri*segs+si; b = ri*segs+(si+1)%segs
            d = (ri+1)*segs+si; e = (ri+1)*segs+(si+1)%segs
            if ri == 0: fs.append((a, e, d))
            else: fs.append((a, b, e, d))
    return plate(name, vs, fs, bone, mat, bevel)

def loft(name, rings_def, bone, mat, segs=8, bevel=0.02):
    # rings_def: [(cy, cz, rx, ry)] bottom→top — lofted armor shell,
    # the thing a box can never do: chest taper, flared cuirass.
    vs, fs = [], []
    for ry_, cz, rx, ry in rings_def:
        for si in range(segs):
            ph = (si / segs) * 2 * math.pi
            vs.append((ry_[0] + math.cos(ph)*rx, ry_[1] + math.sin(ph)*ry, cz))
    for ri in range(len(rings_def) - 1):
        for si in range(segs):
            a = ri*segs+si; b = ri*segs+(si+1)%segs
            d = (ri+1)*segs+si; e = (ri+1)*segs+(si+1)%segs
            fs.append((a, b, e, d))
    fs += [tuple(range(segs-1, -1, -1))]
    fs += [tuple(range((len(rings_def)-1)*segs, len(rings_def)*segs))]
    return plate(name, vs, fs, bone, mat, bevel)

# ---- plates (Blender-frame coords: -Y front, +Z up) ----
for s, sx in (('l', 1), ('r', -1)):
    # leg: lofted thigh bell, knee dome, shin guard, boot anatomy
    loft(f'thigh_{s}', [([sx*0.17, -0.01], 0.5, 0.14, 0.12),
                        ([sx*0.17, 0.0], 0.85, 0.19, 0.16),
                        ([sx*0.17, -0.03], 1.0, 0.22, 0.17)],
         'thigh_'+s, ARMOR, 8, 0.04)
    dome(f'knee_{s}', [sx*0.18, -0.1, 0.5], 0.15, 'calf_'+s, DARK, 8, 4, 0.03, (1,0.9,1))
    loft(f'shin_{s}', [([sx*0.17, -0.01], 0.14, 0.11, 0.09),
                       ([sx*0.17, 0.0], 0.42, 0.14, 0.11)],
         'calf_'+s, ARMOR, 8, 0.03)
    slab(f'sole_{s}', [sx*0.17, -0.08, 0.03], [0.13,0.22,0.035], 'foot_'+s, DARK, 0.02)
    slab(f'toe_{s}', [sx*0.17, -0.2, 0.1], [0.13,0.12,0.08], 'foot_'+s, ARMOR, 0.04)
    slab(f'heel_{s}', [sx*0.17, 0.1, 0.1], [0.11,0.07,0.09], 'foot_'+s, DARK, 0.03)
    slab(f'ankle_{s}', [sx*0.17, 0.02, 0.14], [0.11,0.1,0.08], 'foot_'+s, DARK, 0.03)
    # arm: domed pauldron over a dark rim, bracer, block fist
    dome(f'pauldron_{s}', [sx*0.42, 0.02, 1.52], 0.27, 'clavicle_'+s, ARMOR, 8, 4, 0.04, (1,1,0.85))
    loft(f'pauldrim_{s}', [([sx*0.42, 0.02], 1.5, 0.26, 0.24),
                           ([sx*0.42, 0.02], 1.56, 0.27, 0.25)],
         'clavicle_'+s, DARK, 8, 0.02)
    cyl(f'bicep_{s}', [sx*0.55, 0.01, 1.49], 0.11, 0.24, 'upperarm_'+s, ARMOR, 8, 0.03)
    cyl(f'elbow_{s}', [sx*0.7, 0.04, 1.45], 0.1, 0.1, 'lowerarm_'+s, DARK)
    loft(f'bracer_{s}', [([sx*0.76, 0.04], 1.44, 0.1, 0.09),
                         ([sx*0.94, 0.04], 1.44, 0.14, 0.12)],
         'lowerarm_'+s, ARMOR, 8, 0.04)
    slab(f'fist_{s}', [sx*1.01, 0.03, 1.44], [0.11,0.1,0.1], 'hand_'+s, DARK, 0.04)
    slab(f'thumb_{s}', [sx*0.97, -0.07, 1.43], [0.04,0.05,0.06], 'hand_'+s, DARK, 0.02)
    slab(f'spike_{s}', [sx*0.44, 0.03, 1.85], [0.06,0.06,0.09], 'clavicle_'+s, ACCENT, 0.02)

# torso: lofted cuirass — waist narrow, chest flares, a real breastplate
loft('pelvis', [([0, 0], 0.86, 0.32, 0.2), ([0, 0.02], 1.06, 0.3, 0.2)], 'pelvis', DARK, 8, 0.05)
slab('belt', [0, -0.04, 1.0], [0.37,0.23,0.05], 'pelvis', ARMOR, 0.03)
slab('cod', [0, -0.12, 0.86], [0.14,0.1,0.1], 'pelvis', ARMOR, 0.04)
loft('gut', [([0, 0], 1.1, 0.3, 0.22), ([0, 0.02], 1.44, 0.34, 0.24)], 'spine_03', DARK, 8, 0.05)
loft('chest', [([0, -0.02], 1.34, 0.34, 0.26),
               ([0, -0.05], 1.56, 0.44, 0.31),
               ([0, -0.02], 1.66, 0.4, 0.27)],
     'spine_03', ARMOR, 8, 0.05)
slab('chestplate', [0, -0.32, 1.5], [0.3,0.06,0.12], 'spine_03', ARMOR, 0.03)
slab('back_hi', [0, 0.27, 1.52], [0.4,0.1,0.16], 'spine_03', DARK, 0.07)
slab('back_lo', [0, 0.22, 1.3], [0.34,0.1,0.13], 'spine_03', DARK, 0.06)
# backpack landmark + jet canisters — cylinders where cylinders belong
slab('pack', [0, 0.34, 1.55], [0.22,0.1,0.2], 'spine_03', DARK, 0.05)
cyl('jet_l', [-0.14, 0.38, 1.62], 0.06, 0.3, 'spine_03', DARK, 8, 0.02)
cyl('jet_r', [0.14, 0.38, 1.62], 0.06, 0.3, 'spine_03', DARK, 8, 0.02)
slab('vent_l', [-0.14, 0.4, 1.78], [0.05,0.04,0.06], 'spine_03', ACCENT, 0.01)
slab('vent_r', [0.14, 0.4, 1.78], [0.05,0.04,0.06], 'spine_03', ACCENT, 0.01)

# gorget + helm dome — pilot-scale, tucked between pauldrons
cyl('gorget', [0, 0.01, 1.74], 0.24, 0.36, 'neck_01', DARK, 10, 0.04)
dome('helm', [0, 0.02, 1.82], 0.21, 'head', ARMOR, 8, 4, 0.04, (1,1,1.1))
slab('visor', [0, -0.19, 1.94], [0.18,0.04,0.035], 'head', DARK, 0.02)
slab('eyeslit', [0, -0.21, 1.94], [0.13,0.015,0.02], 'head', ACCENT, 0.01)
slab('crest', [0, 0.06, 2.08], [0.05,0.06,0.04], 'head', ACCENT, 0.02)

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB',
                          export_animations=True, export_skins=True)
subprocess.run('npx -y gltfpack -i "' + OUT_GLB + '" -o "' + OUT_GLB + '" -cc -kn', shell=True, check=True)
print('bld ->', OUT_GLB, 'and', OUT_BLEND)

# ---- turntable render for visual check (workbench, no lights needed) ----
scn = bpy.context.scene
scn.render.engine = 'BLENDER_WORKBENCH'
scn.display.shading.light = 'STUDIO'
scn.display.shading.show_shadows = True
scn.display.shading.show_cavity = True
scn.display.shading.cavity_type = 'BOTH'
scn.display.shading.color_type = 'MATERIAL'
scn.render.resolution_x = scn.render.resolution_y = 640
scn.render.film_transparent = False
scn.world = bpy.data.worlds.new('w') if not scn.world else scn.world
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
bpy.context.collection.objects.link(cam)
scn.camera = cam
for i, ang in enumerate([math.radians(a) for a in (35, 125, 215, 305)]):
    cam.location = (5.5 * math.cos(ang), 5.5 * math.sin(ang), 1.6)
    d = Vector((0, 0, 1.0)) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scn.render.filepath = ROOT + f'/_tools/models/bld_shot_{i}.png'
    bpy.ops.render.render(write_still=True)
print('renders -> _tools/models/bld_shot_*.png')
