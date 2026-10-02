import bpy
mat = bpy.data.materials["Material"]
for n in mat.node_tree.nodes:
    if n.name == 'Mix':
        for i in n.inputs:
            print("IN", i.name, getattr(i,'default_value',''), [l.from_node.name for l in i.links])
