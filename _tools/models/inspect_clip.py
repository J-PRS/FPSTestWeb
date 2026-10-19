import bpy, sys

argv = sys.argv[sys.argv.index("--") + 1:]
path, want = argv[0], argv[1] if len(argv) > 1 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)

def fcurves(a):
    if hasattr(a, 'fcurves'):
        yield from a.fcurves
        return
    for layer in a.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves

for a in bpy.data.actions:
    if want and a.name != want:
        continue
    print('==', a.name)
    for fc in fcurves(a):
        if 'location' not in fc.data_path and fc.data_path not in ('location',):
            continue
        lo = min(k.co[1] for k in fc.keyframe_points)
        hi = max(k.co[1] for k in fc.keyframe_points)
        if hi - lo > 0.05:
            print(f'   {fc.data_path}[{fc.array_index}] range {lo:.2f}..{hi:.2f}')
