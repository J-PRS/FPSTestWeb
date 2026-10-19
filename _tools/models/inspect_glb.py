import bpy, sys, json

argv = sys.argv[sys.argv.index("--") + 1:]
path = argv[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)

for ob in bpy.data.objects:
    if ob.type == "ARMATURE":
        print("ARMATURE", ob.name)
        for b in ob.data.bones:
            h = ob.matrix_world @ b.head_local
            t = ob.matrix_world @ b.tail_local
            print(f"  BONE {b.name} parent={b.parent.name if b.parent else None} head=({h.x:.3f},{h.y:.3f},{h.z:.3f}) tail=({t.x:.3f},{t.y:.3f},{t.z:.3f})")
    elif ob.type == "MESH":
        print("MESH", ob.name, "verts", len(ob.data.vertices))

for a in bpy.data.actions:
    print("ACTION", a.name, "frames", round(a.frame_range[0]), "-", round(a.frame_range[1]))
