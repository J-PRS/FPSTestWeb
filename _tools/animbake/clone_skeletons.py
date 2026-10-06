# Normalize class_heavy.glb's 5-skeleton rig: each part mesh (head/body/
# backpack/arm/leg) has its own 57-bone tree, but only Body1's carries real
# transforms — the other four are identity chains nested inside it, so their
# meshes render rigidly. The IBMs are already real per-bone binds (identical
# to the canonical skin's), so the fix is: copy the canonical TRS into every
# duplicate tree, reparent the tree roots as siblings of the canonical root,
# and duplicate every clip channel onto each tree (the loader dedups node
# names, so Hips_1.position-style tracks bind to each clone).
import json, struct

SRC = 'client/public/assets/models/class_heavy.glb'

raw = open(SRC, 'rb').read()
jlen = struct.unpack('<I', raw[12:16])[0]
g = json.loads(raw[20:20+jlen])
bin_off = 20 + jlen + 8
binbuf = raw[bin_off:]
nodes = g['nodes']

parent = {}
for i, n in enumerate(nodes):
    for c in n.get('children', []):
        parent[c] = i

canon = g['skins'][1]['joints']              # Body1 — the animated tree
canon_root_parent = parent[canon[0]]         # node 0 (armature root)
canon_names = {nodes[j].get('name'): j for j in canon}

for k, sk in enumerate(g['skins']):
    if k == 1:
        continue
    # 1. clone canonical TRS into every node of this tree
    for a, b in zip(sk['joints'], canon):
        for key in ('translation', 'rotation', 'scale'):
            if key in nodes[b]:
                nodes[a][key] = list(nodes[b][key])
            else:
                nodes[a].pop(key, None)
    # 2. reparent this tree's root next to the canonical root
    root = sk['joints'][0]
    oldp = parent[root]
    nodes[oldp]['children'].remove(root)
    nodes[canon_root_parent].setdefault('children', []).append(root)

# 3. duplicate every animation channel for each clone tree
name_to_clones = {}
for k, sk in enumerate(g['skins']):
    if k == 1:
        continue
    for a, b in zip(sk['joints'], canon):
        name_to_clones.setdefault(b, []).append(a)

for anim in g['animations']:
    extra = []
    for ch in anim['channels']:
        tgt = ch['target']['node']
        for clone in name_to_clones.get(tgt, []):
            extra.append({'sampler': ch['sampler'],
                          'target': {'node': clone, 'path': ch['target']['path']}})
    anim['channels'] += extra

jb = json.dumps(g, separators=(',', ':')).encode()
jb += b' ' * ((4 - len(jb) % 4) % 4)
newbin = binbuf + b'\x00' * ((4 - len(binbuf) % 4) % 4)
total = 12 + 8 + len(jb) + 8 + len(newbin)
with open(SRC, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, total))
    f.write(struct.pack('<I4s', len(jb), b'JSON') + jb)
    f.write(struct.pack('<I4s', len(newbin), b'BIN\x00') + newbin)
print('cloned canonical TRS into 4 trees, reparented roots, duplicated channels')
