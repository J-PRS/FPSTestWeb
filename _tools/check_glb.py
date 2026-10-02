import bpy, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
for p in sys.argv[sys.argv.index("--")+1:]:
    bpy.ops.import_scene.gltf(filepath=p)
    for o in bpy.data.objects:
        if o.type=='MESH':
            print("MESH", o.name, "verts", len(o.data.vertices), "uv", len(o.data.uv_layers), "mats", [m.name if m else None for m in o.data.materials])
