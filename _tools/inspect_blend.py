import bpy, sys
for ob in bpy.data.objects:
    print("OBJ", ob.name, ob.type)
for mat in bpy.data.materials:
    print("MAT", mat.name, "nodes:", [n.type for n in mat.node_tree.nodes] if mat.use_nodes else "none")
for img in bpy.data.images:
    print("IMG", img.name, img.filepath)
