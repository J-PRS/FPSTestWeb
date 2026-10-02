import bpy
mat = bpy.data.materials["Material"]
nt = mat.node_tree
def dump(n):
    outs = {o.name: o.default_value if hasattr(o,'default_value') else '' for o in n.inputs}
    print(f"{n.name} [{n.type}] loc={tuple(n.location)}")
    for i in n.inputs:
        if i.links: print(f"   {i.name} <- {i.links[0].from_node.name}:{i.links[0].from_socket.name}")
        elif hasattr(i,'default_value'): print(f"   {i.name} = {i.default_value}")
    if n.type=='VALTORGB':
        cr=n.color_ramp
        for e in cr.elements: print(f"   ramp {e.position:.3f} -> {tuple(round(c,3) for c in e.color)}")
for n in nt.nodes: dump(n)
print("LINKS", len(nt.links))
for img in bpy.data.images:
    print("IMGPATH", img.name, img.filepath, img.size[:])
