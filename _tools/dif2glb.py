"""Headless Blender batch: .dif -> .glb via io_dif.

  blender -b -P dif2glb.py -- <in.dif> <out.glb> [texdir]

Mounts the io_dif plugin dir directly (no addon install), imports the
interior, exports glTF binary. T2 interiors ship no embedded textures —
`texdir` points at extracted texture PNGs if the plugin wants them.
"""
import sys
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = argv[0], argv[1]

sys.path.append(r"C:\TEMP\_WEB\FPSWebTest\_tools\io_dif\blender_plugin")
import io_dif  # noqa: E402
io_dif.register()

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.dif(filepath=src)

bpy.ops.export_scene.gltf(
    filepath=dst,
    export_format='GLB',
    export_yup=True,
    export_apply=True,
)
print(f"DIF2GLB {src} -> {dst}")
