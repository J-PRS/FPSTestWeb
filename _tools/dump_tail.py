import bpy
mat = bpy.data.materials["Material"]
nt = mat.node_tree
for n in nt.nodes:
    if n.type in ('TEX_VORONOI','TEX_IMAGE') or 'Math.003' in n.name or 'Math.005' in n.name or n.type=='BSDF_PRINCIPLED':
        print(f"{n.name} [{n.type}]")
        for i in n.inputs:
            if i.links: print(f"   {i.name} <- {i.links[0].from_node.name}:{i.links[0].from_socket.name}")
            elif hasattr(i,'default_value'): print(f"   {i.name} = {getattr(i,'default_value','')}")
        if n.type=='TEX_IMAGE': print("   img:", n.image.name if n.image else None, n.image.filepath if n.image else '')
    for o in n.outputs:
        for l in o.links:
            if l.to_node.type=='BSDF_PRINCIPLED' or 'Math.00' in l.to_node.name or 'Mix' == l.to_node.name or 'Output' in l.to_node.name:
                print(f"LINK {n.name}:{o.name} -> {l.to_node.name}:{l.to_socket.name}")
for l in nt.links:
    if l.to_node.type=='OUTPUT_MATERIAL' or (l.from_node.name.startswith('Math.003') or l.from_node.name.startswith('Math.005')):
        print("TAIL", l.from_node.name, l.from_socket.name, "->", l.to_node.name, l.to_socket.name)
