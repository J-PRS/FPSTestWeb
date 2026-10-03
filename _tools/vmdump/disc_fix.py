# Fix disc.blend: step the silhouettes so no two parts share flank planes.
# halves stay 1.00, breech ×1.02, collar ×1.04 — weapon XY == blender X,Z.
import bpy
bpy.ops.wm.open_mainfile(filepath=r'C:\TEMP\_WEB\FPSWebTest\_tools\vmdump\models\disc.blend')
import mathutils
for o in bpy.context.scene.objects:
    if o.type != 'MESH': continue
    mw = o.matrix_world
    bb = [mw @ mathutils.Vector(c) for c in o.bound_box]
    ylo = min(v.y for v in bb); yhi = max(v.y for v in bb)
    print(o.name, 'y', round(ylo,3), round(yhi,3), 'z', round(min(v.z for v in bb),3), round(max(v.z for v in bb),3))
