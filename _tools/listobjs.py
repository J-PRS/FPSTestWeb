import bpy
for o in bpy.data.objects:
    print("OBJ", o.name, o.type, "verts", len(o.data.vertices) if o.type=='MESH' else '', "parent", o.parent.name if o.parent else None)
