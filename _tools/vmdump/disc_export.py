import bpy
bpy.ops.wm.open_mainfile(filepath=r'C:\TEMP\_WEB\FPSWebTest\_tools\vmdump\models\disc.blend')
bpy.ops.export_scene.gltf(filepath=r'C:\TEMP\_WEB\FPSWebTest\_tools\vmdump\models\w1.glb')
print("EXPORTED")
