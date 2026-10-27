# Juggernaut "scp" — one continuous sculpted body, old-school: tubes
# lofted along the real bone positions, vertices smoothly weighted
# across joints (the thing the plate builders can't do — skin stretches
# at knees/elbows/waist instead of shearing). Flat-shaded, low segs.
#
#   blender -b -P _tools/models/build_juggernaut_scp.py
#
# Outputs: _tools/models/juggernaut_scp.blend
#          client/public/assets/models/class_juggernaut_scp.glb
import bpy, math, subprocess
from mathutils import Vector

ROOT = 'C:/TEMP/_WEB/FPSWebTest'
SRC = ROOT + '/client/public/assets/models/class_brute.glb'
OUT_GLB = ROOT + '/client/public/assets/models/class_juggernaut_scp.glb'
OUT_BLEND = ROOT + '/_tools/models/juggernaut_scp.blend'

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
# the GLB imports with Crouch_Idle active — renders/evaluation must see
# REST or the sculpt bakes posed and the turntable shows a crouch
arm.data.pose_position = 'REST'
if arm.animation_data: arm.animation_data.action = None
for o in [o for o in bpy.data.objects if o.type == 'MESH']:
    bpy.data.objects.remove(o, do_unlink=True)

ARMOR = bpy.data.materials.new('armor'); ARMOR.diffuse_color = (0.32, 0.35, 0.38, 1)
DARK = bpy.data.materials.new('dark');   DARK.diffuse_color = (0.13, 0.14, 0.15, 1)
ACCENT = bpy.data.materials.new('accent'); ACCENT.diffuse_color = (0.6, 0.15, 0.1, 1)

# Bone rest positions in world space.
def bone_pt(name, tail=False):
    b = arm.data.bones[name]
    m = arm.matrix_world @ (b.tail_local if tail else b.head_local)
    return Vector(m)

SEGS = 8  # low-seg = the PS1/Quake facet read
vs, fs, vgroups = [], [], {}   # vgroups: bone -> {vi: w}

def addv(p, weights):
    vs.append(tuple(p))
    vi = len(vs) - 1
    for bone, w in weights.items():
        vgroups.setdefault(bone, {})[vi] = w
    return vi

def tube(a, b, ra, rb, bone_a, bone_b=None, bulge=0.0, mat=None):
    """Tube from a to b; weights blend bone_a->bone_b along length."""
    axis = b - a
    L = axis.length or 1
    d = axis.normalized()
    ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((0, 1, 0))
    u = d.cross(ref).normalized(); v = d.cross(u).normalized()
    rings = []
    for ri in range(3):  # 3 rings: ends + mid bulge
        t = ri / 2
        c = a + axis * t
        r = ra + (rb - ra) * t + math.sin(t * math.pi) * bulge
        ring = []
        for si in range(SEGS):
            ph = si / SEGS * 2 * math.pi
            p = c + (u * math.cos(ph) + v * math.sin(ph)) * r
            # weights: rigid at ends, blended mid
            if bone_b and ri == 1:
                w = {bone_a: 0.5, bone_b: 0.5}
            elif bone_b and ri == 2:
                w = {bone_a: 0.3, bone_b: 0.7}
            else:
                w = {bone_a: 1.0}
            ring.append(addv(p, w))
        rings.append(ring)
    base = len(vs) - 3 * SEGS
    for ri in range(2):
        for si in range(SEGS):
            i0 = base + ri * SEGS + si; i1 = base + ri * SEGS + (si + 1) % SEGS
            i2 = base + (ri + 1) * SEGS + si; i3 = base + (ri + 1) * SEGS + (si + 1) % SEGS
            fs.append((i0, i1, i3, i2))
    fs.append(tuple(base + si for si in range(SEGS - 1, -1, -1)))
    fs.append(tuple(base + 2 * SEGS + si for si in range(SEGS)))

def blob(c, rx, ry, rz, bone):
    # lumpy ellipsoid — head, fists, boots
    rings, base = 4, []
    for ri in range(rings + 1):
        th = ri / rings * math.pi
        ring = []
        for si in range(SEGS):
            ph = si / SEGS * 2 * math.pi
            ring.append(addv(Vector((c[0] + math.sin(th) * math.cos(ph) * rx,
                                     c[1] + math.sin(th) * math.sin(ph) * ry,
                                     c[2] + math.cos(th) * rz)), {bone: 1.0}))
        base.append(ring)
    for ri in range(rings):
        for si in range(SEGS):
            a, b = base[ri][si], base[ri][(si + 1) % SEGS]
            d, e = base[ri + 1][si], base[ri + 1][(si + 1) % SEGS]
            if ri == 0: fs.append((a, e, d))
            elif ri == rings - 1: fs.append((a, b, e))
            else: fs.append((a, b, e, d))

# ---- body: limbs as bone-aligned tubes, torso as stacked blobs/tubes ----
for s in ('l', 'r'):
    tube(bone_pt(f'upperarm_{s}'), bone_pt(f'upperarm_{s}', True), 0.12, 0.1,
         f'upperarm_{s}', f'lowerarm_{s}', bulge=0.02)
    tube(bone_pt(f'lowerarm_{s}'), bone_pt(f'lowerarm_{s}', True), 0.11, 0.09,
         f'lowerarm_{s}', f'hand_{s}', bulge=0.015)
    blob(bone_pt(f'hand_{s}'), 0.1, 0.11, 0.1, f'hand_{s}')
    tube(bone_pt(f'thigh_{s}'), bone_pt(f'thigh_{s}', True), 0.17, 0.13,
         f'thigh_{s}', f'calf_{s}', bulge=0.03)
    tube(bone_pt(f'calf_{s}'), bone_pt(f'calf_{s}', True), 0.13, 0.1,
         f'calf_{s}', f'foot_{s}', bulge=0.02)
    # boot = foot->ball tube + a heel blob
    tube(bone_pt(f'foot_{s}'), bone_pt(f'ball_{s}'), 0.09, 0.08,
         f'foot_{s}', f'ball_{s}', bulge=0.01)
    fp = bone_pt(f'foot_{s}')
    blob((fp.x, fp.y, fp.z - 0.02), 0.11, 0.13, 0.09, f'foot_{s}')

# torso chain: pelvis→spine_01→03→neck→head — blended across the chain
tube(bone_pt('pelvis'), bone_pt('spine_01'), 0.34, 0.3, 'pelvis', 'spine_01', bulge=0.02)
tube(bone_pt('spine_01'), bone_pt('spine_03'), 0.28, 0.36, 'spine_01', 'spine_03', bulge=0.03)
tube(bone_pt('spine_03'), bone_pt('neck_01'), 0.34, 0.2, 'spine_03', 'neck_01')
tube(bone_pt('neck_01'), bone_pt('head'), 0.18, 0.14, 'neck_01', 'head')
hp = bone_pt('head')
blob((hp.x, hp.y, hp.z + 0.08), 0.16, 0.17, 0.16, 'head')
# pauldron masses — clavicle x is only ~0.1 (near the spine), so key off
# the UPPERARM joint and push well outboard; buried blobs read as crumbs.
for s in ('l', 'r'):
    sx = 1 if s == 'l' else -1
    cp = bone_pt(f'clavicle_{s}')
    blob((sx * 0.38, cp.y - 0.02, cp.z + 0.12), 0.26, 0.26, 0.2, f'clavicle_{s}')
# hip masses — flank the pelvis outboard so the waist reads continuous
for s in ('l', 'r'):
    sx = 1 if s == 'l' else -1
    tp = bone_pt(f'thigh_{s}')
    blob((sx * 0.2, tp.y + 0.02, tp.z + 0.08), 0.14, 0.15, 0.15, f'thigh_{s}')

me = bpy.data.meshes.new('scp')
me.from_pydata(vs, [], fs); me.update()
me.materials.append(ARMOR)
ob = bpy.data.objects.new('scp', me)
bpy.context.collection.objects.link(ob)
for bone, wmap in vgroups.items():
    vg = ob.vertex_groups.new(name=bone)
    for vi, w in wmap.items():
        vg.add([vi], w, 'REPLACE')
mod = ob.modifiers.new('arm', 'ARMATURE'); mod.object = arm
ob.parent = arm
# flat shading IS the old-school read — no smooth normals
for p in me.polygons: p.use_smooth = False

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB',
                          export_animations=True, export_skins=True)
subprocess.run('npx -y gltfpack -i "' + OUT_GLB + '" -o "' + OUT_GLB + '" -cc -kn', shell=True, check=True)

# turntable render
scn = bpy.context.scene
scn.render.engine = 'BLENDER_WORKBENCH'
scn.display.shading.show_shadows = True
scn.display.shading.show_cavity = True
scn.display.shading.cavity_type = 'BOTH'
scn.display.shading.color_type = 'MATERIAL'
scn.render.resolution_x = scn.render.resolution_y = 640
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
bpy.context.collection.objects.link(cam); scn.camera = cam
for i, ang in enumerate([math.radians(a) for a in (35, 125, 215, 305)]):
    cam.location = (5.5 * math.cos(ang), 5.5 * math.sin(ang), 1.6)
    d = Vector((0, 0, 1.0)) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scn.render.filepath = ROOT + f'/_tools/models/scp_shot_{i}.png'
    bpy.ops.render.render(write_still=True)
print('scp ->', OUT_GLB, len(vs), 'verts', len(fs), 'faces')
