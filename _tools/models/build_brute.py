"""Build a chunky Keel-style brute humanoid, rigid-skinned onto the
Mesh2Motion human skeleton with its native clips embedded — the GLB
self-animates, no runtime retarget bake (sources: []).

Skeleton/anims: mesh2motion-app/static/animations/human-base-animations.glb
(MIT/CC0). Every body part is a heavily-rounded plate bound 100% to one
bone — hard-surface skinning, no weight painting.

Run:  blender -b --factory-startup --python build_brute.py -- <anim.glb> <out.glb>
"""
import bpy
import bmesh
import sys

argv = sys.argv[sys.argv.index('--') + 1:]
OUT = argv[-1]
ANIM_GLBS = argv[:-1]   # first = skeleton source; rest = extra clip packs

# clips the game actually maps to states — keep the GLB lean
KEEP = {
    # human-base pack
    'Idle_A', 'Pistol_Idle', 'Pistol_Aim_Neutral', 'Pistol_Shoot',
    'Walk', 'Jog', 'Sprint',
    'Jump_Start', 'Jump_air', 'Jump_Land',
    'Slide', 'NinjaJump_Idle', 'Crouch_Idle', 'Crouch_Walk',
    'OverhandThrow', 'Hit_Chest', 'Hit_Knockback', 'Death_D',
    # addon pack — heavier Tribes-flavored picks
    'Walk_Large', 'Run_Anime', 'Glide', 'Fighting Idle',
    'Two-hand Blast', 'Throw Object', 'Death_A',
    'Strafe_left', 'Strafe_right', 'Walk_Backwards', 'Levitate Idle', 'Jump_2',
}

# ---------- import skeleton + clips ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=ANIM_GLBS[0])

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
arm.name = 'brute'
for ob in [o for o in bpy.data.objects if o.type == 'MESH']:
    bpy.data.objects.remove(ob, do_unlink=True)

# extra packs: same skeleton — keep only their actions, drop rigs/meshes
for extra in ANIM_GLBS[1:]:
    before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=extra)
    for ob in [o for o in bpy.data.objects if o is not None and o.name != arm.name and o.type in ('ARMATURE', 'MESH')]:
        bpy.data.objects.remove(ob, do_unlink=True)
    for a in [a for a in bpy.data.actions if a not in before and a.name not in KEEP]:
        bpy.data.actions.remove(a)
for a in [a for a in bpy.data.actions if a.name not in KEEP]:
    bpy.data.actions.remove(a)
# strip root-bone translation — clips that bake root motion (hit/knockback
# lunges) would lift the model off the ground; the game owns position.
def action_fcurves(a):
    if hasattr(a, 'fcurves'):
        yield a.fcurves
        return
    for layer in a.layers:                      # slotted actions (Blender 4.4+)
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield bag.fcurves

for a in bpy.data.actions:
    for fcs in action_fcurves(a):
        for fc in [fc for fc in fcs if fc.data_path == 'pose.bones["root"].location']:
            fcs.remove(fc)

print('KEPT ACTIONS:', sorted(a.name for a in bpy.data.actions))

def mat(name, rgb, metallic=0.0, rough=0.75):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = rough
    return m

ARMOR = mat('armor', (0.30, 0.32, 0.35), metallic=0.4, rough=0.55)
DARK = mat('dark', (0.07, 0.08, 0.09), metallic=0.5, rough=0.6)
ACCENT = mat('accent', (0.45, 0.12, 0.10), metallic=0.2, rough=0.7)

parts = []

def plate(name, loc, dims, material, bone, taper=None, rnd=0.35, wedge=0.0, pinch=0.0):
    """Tapered box with bevel = rnd * min(dims) — the rounded-slab look."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    m = bpy.data.meshes.new(name)
    bm.to_mesh(m)
    bm.free()
    ob = bpy.data.objects.new(name, m)
    scene.collection.objects.link(ob)
    sx, sy, sz = dims
    for v in m.vertices:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
        if taper:
            tx, ty = taper
            t = (v.co.z / sz + 0.5)
            v.co.x *= (1 + (tx - 1) * t)
            v.co.y *= (1 + (ty - 1) * t)
        if wedge:
            # thin the -Y (toe) end vertically, keep the +Y (ankle) end fat
            t = (v.co.y / sy + 0.5)
            v.co.z *= (1 + (wedge - 1) * (1 - t))
        if pinch:
            # narrow the -Y (toe) end horizontally — the pointed boot front
            t = (v.co.y / sy + 0.5)
            v.co.x *= (1 - pinch * (1 - t))
    ob.location = loc
    m.materials.append(material)
    for p in m.polygons:
        p.use_smooth = True   # always smooth — hard edges come from textures, not faceting
    w = min(rnd * min(dims), min(dims) * 0.49)
    if w > 0.004:
        mod = ob.modifiers.new('bev', 'BEVEL')
        mod.width = w
        mod.segments = 2
    parts.append((ob, bone))
    return ob

# ---------- plates on the M2M skeleton (~1.73m, +X=left, -Y=front) ----------
# Keel silhouette: huge carapace torso ~45% of height, gorilla arms, stubby legs.
for s, x in [('l', 0.11), ('r', -0.11)]:
    plate(f'thigh{s}', (x, -0.01, 0.70), (0.34, 0.34, 0.50), ARMOR, f'thigh_{s}', taper=(0.72, 0.78), rnd=0.18)
    plate(f'knee{s}',  (x, 0.0, 0.50), (0.22, 0.24, 0.10), DARK, f'calf_{s}', rnd=0.35)
    plate(f'shin{s}',  (x, 0.02, 0.30), (0.30, 0.30, 0.34), ARMOR, f'calf_{s}', taper=(0.68, 0.75), rnd=0.2)
    plate(f'foot{s}',  (x, -0.10, 0.10), (0.30, 0.46, 0.26), DARK, f'foot_{s}', taper=(0.9, 0.95), rnd=0.4, wedge=0.45, pinch=0.3)
    plate(f'heel{s}',  (x, 0.10, 0.14), (0.26, 0.20, 0.28), DARK, f'foot_{s}', rnd=0.45)
    plate(f'ankle{s}', (x, 0.07, 0.22), (0.22, 0.22, 0.24), ARMOR, f'calf_{s}', rnd=0.3)
    plate(f'instep{s}', (x, -0.14, 0.16), (0.20, 0.20, 0.22), DARK, f'calf_{s}', rnd=0.45)

plate('pelvis', (0, 0.0, 0.95), (0.54, 0.36, 0.22), DARK, 'pelvis', rnd=0.3)
plate('codplate', (0, -0.16, 0.88), (0.22, 0.14, 0.26), ARMOR, 'pelvis', taper=(0.8, 1.0), rnd=0.25)

# waist ring — dark underlayer between pelvis and carapace reads as a joint
plate('waist', (0, 0.0, 1.06), (0.40, 0.30, 0.12), DARK, 'spine_01', rnd=0.3)
plate('belly',  (0, 0.02, 1.15), (0.50, 0.34, 0.16), DARK, 'spine_02', rnd=0.3)
plate('chest',  (0, -0.03, 1.38), (0.78, 0.50, 0.36), ARMOR, 'spine_03', taper=(1.0, 0.72), rnd=0.18)
plate('collar', (0, -0.04, 1.54), (0.56, 0.42, 0.12), DARK, 'spine_03', rnd=0.3)
plate('spineplate', (0, 0.25, 1.38), (0.40, 0.14, 0.34), DARK, 'spine_03', rnd=0.25)
for s, x in [('l', 0.20), ('r', -0.20)]:
    plate(f'stack{s}', (x, 0.30, 1.46), (0.13, 0.13, 0.26), DARK, 'spine_03', rnd=0.25)

# arms: pauldron = angular blade wedge, thin dark elbow joint between plates
for s, x in [('l', 1), ('r', -1)]:
    plate(f'pauldron{s}', (x*0.26, -0.01, 1.49), (0.40, 0.44, 0.30), ARMOR, f'clavicle_{s}', taper=(0.55, 0.7), rnd=0.15)
    plate(f'uarm{s}',  (x*0.35, 0.05, 1.44), (0.32, 0.24, 0.22), ARMOR, f'upperarm_{s}', rnd=0.22)
    plate(f'elbow{s}', (x*0.50, 0.05, 1.44), (0.16, 0.18, 0.18), DARK, f'lowerarm_{s}', rnd=0.3)
    plate(f'farm{s}',  (x*0.63, 0.05, 1.44), (0.40, 0.24, 0.22), ARMOR, f'lowerarm_{s}', taper=(0.7, 0.7), rnd=0.2)
    plate(f'fist{s}',  (x*0.86, 0.05, 1.42), (0.28, 0.26, 0.22), DARK, f'hand_{s}', rnd=0.3)

plate('neck',  (0, 0.0, 1.52), (0.18, 0.20, 0.14), DARK, 'neck_01', rnd=0.3)
plate('helm',  (0, -0.02, 1.66), (0.34, 0.36, 0.26), ARMOR, 'head', taper=(0.78, 0.9), rnd=0.25)
plate('visor', (0, -0.19, 1.70), (0.28, 0.05, 0.08), DARK, 'head', rnd=0.3)
plate('crest', (0, 0.06, 1.78), (0.08, 0.28, 0.06), ACCENT, 'head', rnd=0.2)

# ---------- rigid bind ----------
for ob, bname in parts:
    vg = ob.vertex_groups.new(name=bname)
    vg.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    ob.parent = arm
    mod = ob.modifiers.new('arm', 'ARMATURE')
    mod.object = arm

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB',
                        export_yup=True, export_apply=True,
                        export_animation_mode='ACTIONS')
print('EXPORTED', OUT)
