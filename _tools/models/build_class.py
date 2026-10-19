"""Build one armored-class humanoid, rigid-skinned onto the Mesh2Motion
human skeleton with its native clips embedded — the GLB self-animates,
no runtime retarget bake (sources: []).

Three bodies off one skeleton so the anims table + aimMask carry over:
  brute   — heavy: Keel carapace, domed plates, crest
  brawler — medium: leaner shell, asymmetric right war-pauldron, bare-helm jaw
  scout   — light: exposed frame, fins instead of pauldrons, runner boots

Skeleton/anims: mesh2motion-app/static/animations/human-base-animations.glb
(MIT/CC0). Every body part is a rounded plate bound 100% to one bone —
hard-surface skinning, no weight painting.

Run:  blender -b --factory-startup --python build_class.py -- <anim.glb>... <out.glb> <class>
"""
import bpy
import bmesh
import sys

argv = sys.argv[sys.argv.index('--') + 1:]
CLASS = argv[-1]
OUT = argv[-2]
ANIM_GLBS = argv[:-2]   # first = skeleton source; rest = extra clip packs

# clips the game actually maps to states — keep the GLB lean
KEEP = {
    # human-base pack
    'Idle_A', 'Pistol_Idle', 'Pistol_Shoot',
    # the aim layer's pitch ladder — Neutral alone leaves the arm chain
    # un-owned past ±55° pitch (weight fades to 0, stale bind-pose arms)
    'Pistol_Aim_Neutral', 'Pistol_Aim_Up', 'Pistol_Aim_Down',
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
arm.name = CLASS
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

parts = []

def plate(name, loc, dims, material, bone, taper=None, rnd=0.35, wedge=0.0, pinch=0.0, bulge=0.12):
    """Tapered box; bevel=rnd*min(dims) softens edges, bulge pushes each
    face's center outward along its axis — the carapace look: plates bow
    like grown armor, not chamfered boxes."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    if bulge:
        # cuts=1 — one center vert per face, pushed out by bulge = the
        # Quake-era pyramid face. cuts=2 read as soft pillows, not plates.
        bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=1, use_grid_fill=True)
    m = bpy.data.meshes.new(name)
    bm.to_mesh(m)
    bm.free()
    ob = bpy.data.objects.new(name, m)
    scene.collection.objects.link(ob)
    sx, sy, sz = dims
    for v in m.vertices:
        u = (v.co.x, v.co.y, v.co.z)   # normalized [-1,1] before scaling
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
        if bulge:
            # dominant axis = the face this vert belongs to; pull it out by
            # bulge*half-dim scaled by how centered the vert is on the face
            a = max(range(3), key=lambda i: abs(u[i]))
            # max-perp, not mean — face EDGE verts keep their corner
            # height (crisp pyramid), only the true center pops out
            perp = max(abs(u[(a + 1) % 3]), abs(u[(a + 2) % 3])) ** 2
            half = (sx, sy, sz)[a] * 0.5
            co = (v.co.x, v.co.y, v.co.z)
            c = co[a] * (1 + bulge * (1 - perp))
            if a == 0: v.co.x = c
            elif a == 1: v.co.y = c
            else: v.co.z = c
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

# ---------- bodies (~1.73m skeleton, +X=left, -Y=front) ----------

def body_brute(ARMOR, DARK, ACCENT):
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


def body_brawler(ARMOR, DARK, ACCENT):
    """Medium: boxer anatomy — the mass lives in the fists and forearms,
    torso compact and dropped forward, hips wide. Asymmetric right
    war-pauldron; banded chest instead of the brute's carapace."""
    for s, x in [('l', 0.11), ('r', -0.11)]:   # wide stance — the legs spread like a fighter's
        plate(f'thigh{s}', (x, -0.01, 0.70), (0.28, 0.28, 0.44), ARMOR, f'thigh_{s}', taper=(0.70, 0.76), rnd=0.18)
        plate(f'knee{s}',  (x, 0.0, 0.52), (0.20, 0.22, 0.09), DARK, f'calf_{s}', rnd=0.35)
        plate(f'shin{s}',  (x, 0.02, 0.31), (0.27, 0.27, 0.34), ARMOR, f'calf_{s}', taper=(0.66, 0.74), rnd=0.2)
        plate(f'foot{s}',  (x, -0.09, 0.10), (0.28, 0.42, 0.24), DARK, f'foot_{s}', taper=(0.9, 0.95), rnd=0.4, wedge=0.45, pinch=0.35)
        plate(f'heel{s}',  (x, 0.09, 0.14), (0.24, 0.18, 0.26), DARK, f'foot_{s}', rnd=0.45)
        plate(f'ankle{s}', (x, 0.06, 0.23), (0.21, 0.21, 0.22), ARMOR, f'calf_{s}', rnd=0.3)
        plate(f'instep{s}', (x, -0.12, 0.16), (0.19, 0.18, 0.20), DARK, f'calf_{s}', rnd=0.45)

    # wide low pelvis — the power stance
    plate('pelvis', (0, 0.0, 0.94), (0.52, 0.34, 0.20), DARK, 'pelvis', rnd=0.3)
    plate('codplate', (0, -0.15, 0.88), (0.20, 0.12, 0.22), ARMOR, 'pelvis', taper=(0.8, 1.0), rnd=0.25)

    # banded torso, mass dropped: armor slats sit lower, chest hunches fwd
    plate('waist', (0, 0.0, 1.06), (0.38, 0.28, 0.11), DARK, 'spine_01', rnd=0.3)
    plate('band1', (0, -0.03, 1.19), (0.58, 0.34, 0.13), ARMOR, 'spine_02', rnd=0.2)
    plate('midriff', (0, 0.01, 1.29), (0.46, 0.28, 0.10), DARK, 'spine_02', rnd=0.3)
    plate('chest', (0, -0.04, 1.40), (0.64, 0.42, 0.28), ARMOR, 'spine_03', taper=(1.0, 0.74), rnd=0.18)
    plate('spineplate', (0, 0.21, 1.38), (0.34, 0.12, 0.30), DARK, 'spine_03', rnd=0.25)
    # yoke — the pauldrons mount on clavicles that float off the chest;
    # a strap across the collarbones visually ties them into the shell
    plate('yoke', (0, -0.01, 1.52), (0.52, 0.34, 0.12), DARK, 'spine_03', rnd=0.3)

    # both shoulders armored — the right war-pauldron just runs bigger,
    # asymmetric without reading as a missing part
    plate('pauldronl', (0.24, -0.01, 1.49), (0.30, 0.36, 0.24), ARMOR, 'clavicle_l', taper=(0.58, 0.72), rnd=0.16)
    plate('pauldronr', (-0.28, 0.02, 1.48), (0.34, 0.40, 0.30), ARMOR, 'clavicle_r', taper=(0.55, 0.65), rnd=0.15)
    plate('spiker', (-0.39, 0.04, 1.58), (0.08, 0.13, 0.16), ACCENT, 'clavicle_r', taper=(0.5, 0.7), rnd=0.2)
    # boxer arms: thin upper arm, then the forearm swells INTO the fist —
    # gauntlet ends where the hand plate begins, no wrist break
    for s, x in [('l', 1), ('r', -1)]:
        plate(f'uarm{s}',  (x*0.34, 0.05, 1.44), (0.24, 0.20, 0.19), ARMOR, f'upperarm_{s}', rnd=0.22)
        plate(f'elbow{s}', (x*0.50, 0.05, 1.44), (0.15, 0.17, 0.17), DARK, f'lowerarm_{s}', rnd=0.3)
        plate(f'farm{s}',  (x*0.64, 0.05, 1.44), (0.34, 0.24, 0.23), ARMOR, f'lowerarm_{s}', taper=(0.8, 0.8), rnd=0.2)
        plate(f'fist{s}',  (x*0.88, 0.05, 1.42), (0.34, 0.30, 0.26), DARK, f'hand_{s}', rnd=0.35)

    plate('neck',  (0, 0.0, 1.52), (0.16, 0.18, 0.13), DARK, 'neck_01', rnd=0.3)
    plate('helm',  (0, -0.02, 1.67), (0.30, 0.32, 0.24), ARMOR, 'head', taper=(0.8, 0.92), rnd=0.25)
    plate('jaw',   (0, -0.16, 1.60), (0.22, 0.10, 0.10), DARK, 'head', rnd=0.35)   # bare chin plate
    plate('visor', (0, -0.17, 1.70), (0.24, 0.05, 0.07), DARK, 'head', rnd=0.3)
    plate('mohawk', (0, 0.05, 1.79), (0.05, 0.22, 0.05), ACCENT, 'head', rnd=0.2)


def body_scout(ARMOR, DARK, ACCENT):
    """Light: exposed frame — thin dark limbs with sparse armor shells,
    swept-back shoulder FINS (not pauldrons), narrow runner boot,
    needle helm. Reads fast even standing still."""
    # long-leg read: leg plates sit lower/slimmer, pads float on the frame
    for s, x in [('l', 0.09), ('r', -0.09)]:
        plate(f'thigh{s}', (x, -0.01, 0.68), (0.20, 0.20, 0.46), DARK, f'thigh_{s}', taper=(0.66, 0.72), rnd=0.18)
        plate(f'thighpad{s}', (x*1.3, -0.05, 0.76), (0.15, 0.18, 0.22), ARMOR, f'thigh_{s}', taper=(0.7, 0.8), rnd=0.25)
        plate(f'knee{s}',  (x, -0.02, 0.54), (0.17, 0.17, 0.08), ARMOR, f'calf_{s}', rnd=0.35)   # knee cap is armor, not joint-dark
        plate(f'shin{s}',  (x, 0.02, 0.33), (0.17, 0.18, 0.40), DARK, f'calf_{s}', taper=(0.60, 0.70), rnd=0.2)
        plate(f'shinpad{s}', (x, -0.06, 0.37), (0.15, 0.15, 0.30), ARMOR, f'calf_{s}', taper=(0.7, 0.8), rnd=0.25)
        plate(f'foot{s}',  (x, -0.08, 0.09), (0.20, 0.34, 0.19), DARK, f'foot_{s}', taper=(0.9, 0.95), rnd=0.4, wedge=0.42, pinch=0.4)
        plate(f'ankle{s}', (x, 0.05, 0.24), (0.15, 0.15, 0.17), ARMOR, f'calf_{s}', rnd=0.3)

    plate('pelvis', (0, 0.0, 0.97), (0.36, 0.24, 0.16), DARK, 'pelvis', rnd=0.3)
    plate('hippad', (0, -0.12, 0.93), (0.15, 0.09, 0.17), ARMOR, 'pelvis', taper=(0.8, 1.0), rnd=0.25)

    # torso rides high and narrow — the upright sprinter silhouette
    plate('waist', (0, 0.0, 1.09), (0.28, 0.22, 0.10), DARK, 'spine_01', rnd=0.3)
    plate('belly',  (0, 0.01, 1.18), (0.31, 0.22, 0.14), DARK, 'spine_02', rnd=0.3)
    # core strap — the gap between belly and chest read as a hole clean
    # through the body; a narrow dark rib fills it without killing the
    # exposed-frame look
    plate('core',   (0, 0.0, 1.30), (0.26, 0.22, 0.22), DARK, 'spine_02', rnd=0.3)
    plate('chest',  (0, -0.02, 1.42), (0.40, 0.28, 0.24), ARMOR, 'spine_03', taper=(1.0, 0.68), rnd=0.18)
    plate('spinefin', (0, 0.20, 1.44), (0.10, 0.10, 0.34), ACCENT, 'spine_03', taper=(0.5, 0.8), rnd=0.2)  # dorsal blade

    # yoke — ties the floating fins into the chest shell
    plate('yoke', (0, -0.01, 1.52), (0.42, 0.28, 0.10), DARK, 'spine_03', rnd=0.3)

    # shoulder fins: small swept plates aimed back — the runner silhouette
    for s, x in [('l', 1), ('r', -1)]:
        plate(f'fin{s}',   (x*0.17, 0.09, 1.54), (0.16, 0.32, 0.10), ARMOR, f'clavicle_{s}', taper=(0.4, 0.6), rnd=0.15)
        plate(f'uarm{s}',  (x*0.34, 0.05, 1.44), (0.17, 0.16, 0.16), DARK, f'upperarm_{s}', rnd=0.22)
        plate(f'elbow{s}', (x*0.50, 0.05, 1.44), (0.13, 0.14, 0.14), ARMOR, f'lowerarm_{s}', rnd=0.3)
        plate(f'farm{s}',  (x*0.63, 0.05, 1.44), (0.20, 0.17, 0.16), DARK, f'lowerarm_{s}', taper=(0.65, 0.65), rnd=0.2)
        plate(f'farmpad{s}', (x*0.60, -0.02, 1.44), (0.16, 0.14, 0.14), ARMOR, f'lowerarm_{s}', rnd=0.25)
        plate(f'fist{s}',  (x*0.86, 0.05, 1.42), (0.18, 0.18, 0.16), DARK, f'hand_{s}', rnd=0.3)

    plate('neck',  (0, 0.0, 1.53), (0.13, 0.15, 0.11), DARK, 'neck_01', rnd=0.3)
    plate('helm',  (0, -0.02, 1.70), (0.22, 0.26, 0.26), ARMOR, 'head', taper=(0.70, 0.85), rnd=0.25)
    plate('visor', (0, -0.14, 1.71), (0.17, 0.04, 0.10), ACCENT, 'head', rnd=0.3)   # glowing slit
    plate('antenna', (0.09, 0.07, 1.84), (0.025, 0.05, 0.22), DARK, 'head', rnd=0.2)


BODY = {
    'brute':   body_brute,
    'brawler': body_brawler,
    'scout':   body_scout,
}
ACCENTS = {'brute': (0.45, 0.12, 0.10), 'brawler': (0.55, 0.30, 0.08), 'scout': (0.10, 0.40, 0.55)}

ARMOR = mat('armor', (0.30, 0.32, 0.35), metallic=0.4, rough=0.55)
DARK = mat('dark', (0.07, 0.08, 0.09), metallic=0.5, rough=0.6)
ACCENT = mat('accent', ACCENTS[CLASS], metallic=0.2, rough=0.7)

BODY[CLASS](ARMOR, DARK, ACCENT)

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
