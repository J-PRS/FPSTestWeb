import bpy
mat = bpy.data.materials["Material"]
nt = mat.node_tree
for n in nt.nodes:
    if n.type=='MATH':
        print("MATHOP", n.name, n.operation)
    if n.type=='MIX':
        print("MIX", n.name, "blend", n.blend_type, "dt", n.data_type, "A", getattr(n.inputs[6],'default_value',None) if len(n.inputs)>6 else '')
        for i in n.inputs:
            if i.links: print("   ",i.name,"<-",i.links[0].from_node.name)
    if n.type=='TEX_VORONOI':
        for o in n.outputs:
            for l in o.links: print("VOR", o.name, "->", l.to_node.name, l.to_socket.name)
        if not any(o.links for o in n.outputs): print("VOR unlinked")
for l in nt.links:
    if l.from_node.name.startswith('Math.005'): print("M5 ->", l.to_node.name, l.to_socket.name)
