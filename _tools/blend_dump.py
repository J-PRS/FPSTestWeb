"""Dump a .blend's objects, materials, and node graphs — run via
blender -b file.blend --python blend_dump.py"""
import bpy

def fmt_input(inp):
    try:
        v = inp.default_value
        if hasattr(v, '__len__'):
            return ' '.join(f'{x:.3g}' for x in v)
        return f'{v:.4g}'
    except Exception:
        return ''

print("\n===== SCENE =====")
for o in bpy.data.objects:
    print(f"obj {o.name} type={o.type} mats={[m.name if m else None for m in getattr(o.data, 'materials', [])] if o.data else []}")

print("\n===== IMAGES =====")
for im in bpy.data.images:
    print(f"img {im.name} src={im.filepath} size={tuple(im.size) if im.has_data else '?'} colorspace={im.colorspace_settings.name}")

print("\n===== MATERIALS =====")
for m in bpy.data.materials:
    print(f"\n--- mat {m.name} use_nodes={m.use_nodes}")
    if not (m.use_nodes and m.node_tree):
        continue
    nt = m.node_tree
    for n in nt.nodes:
        io = []
        if n.bl_idname == 'ShaderNodeTexImage' and n.image:
            io.append(f"IMAGE={n.image.name} ({n.image.filepath})")
        if n.bl_idname == 'ShaderNodeValToRGB':
            stops = [(round(el.position, 3), tuple(round(c, 2) for c in el.color)) for el in n.color_ramp.elements]
            io.append(f"RAMP={stops}")
        for i in n.inputs:
            if i.is_linked:
                for lk in i.links:
                    io.append(f"{i.name}<-{lk.from_node.name}.{lk.from_socket.name}")
            else:
                s = fmt_input(i)
                if s and i.name not in ('Color',):
                    io.append(f"{i.name}={s}")
        print(f"  {n.bl_idname} [{n.name}]" + (f"  {'; '.join(io)}" if io else ""))

print("\n===== WORLD =====")
w = bpy.data.worlds
for world in w:
    print(f"world {world.name} nodes={world.use_nodes}")

print("\n===== DONE =====")
