# 4-view ortho reference of launcher.blend's main-scene mesh for
# procedural rebuild. Usage:
#   blender -b --factory-startup -noaudio _tools/launcher.blend --python _tools/render_launcher.py -- <outdir>
import bpy, os, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
OUT = argv[0]
os.makedirs(OUT, exist_ok=True)

meshes = [o for o in bpy.context.view_layer.objects if o.type == 'MESH']
sc_col = bpy.context.scene.collection

bb = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
c = (lo + hi) / 2
size = max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
print("BBOX", tuple(round(v, 3) for v in lo), tuple(round(v, 3) for v in hi), "size", round(size, 3))

for o in meshes:
    if o.hide_render or (o.hide_viewport if hasattr(o, 'hide_viewport') else False):
        continue
    for p in o.data.polygons:
        p.use_smooth = False

cd = bpy.data.cameras.new("c")
cd.type = 'ORTHO'
cd.ortho_scale = size * 1.15
cam = bpy.data.objects.new("c", cd)
sc_col.objects.link(cam)
sc = bpy.context.scene
sc.camera = cam
d = size * 3

views = {
    "side":   (c + Vector((0, -d, 0)), '-Z', 'Z'),
    "front":  (c + Vector((d, 0, 0)), '-Z', 'Y'),
    "top":    (c + Vector((0, 0, d)), '-Z', 'Y'),
    "persp":  (c + Vector((d * 0.8, -d * 0.8, d * 0.5)), '-Z', 'Y'),
}
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'
sc.display.shading.color_type = 'MATERIAL'
sc.display.shading.show_cavity = True
sc.render.resolution_x = sc.render.resolution_y = 800
sc.render.image_settings.file_format = 'PNG'
for name, (pos, fwd, up) in views.items():
    cam.location = pos
    cam.rotation_euler = (c - pos).to_track_quat('-Z', 'Y').to_euler()
    if name == "top":
        cam.rotation_euler = (c - pos).to_track_quat('-Z', 'X').to_euler()
    sc.render.filepath = os.path.join(OUT, f"launcher_{name}.png")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", sc.render.filepath)
