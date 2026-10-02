import bpy
print("FILE:", bpy.data.filepath)
print("SCENES:", [s.name for s in bpy.data.scenes])
for o in bpy.data.objects:
    if o.type == 'MESH':
        print(f"  MESH {o.name} verts={len(o.data.vertices)}")
    else:
        print(f"  {o.type} {o.name}")
