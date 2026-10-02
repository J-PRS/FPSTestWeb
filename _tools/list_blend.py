import bpy
print("SCENES:", [s.name for s in bpy.data.scenes])
for s in bpy.data.scenes:
    print("=== scene", s.name)
    for o in s.objects.all_objects if hasattr(s.objects,'all_objects') else s.objects:
        if o.type == 'MESH':
            print(f"  MESH {o.name} verts={len(o.data.vertices)} hidden={o.hide_render} coll={[c.name for c in o.users_collection]}")
        else:
            print(f"  {o.type} {o.name}")
