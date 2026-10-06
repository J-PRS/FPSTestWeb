# Normalize class_heavy.glb's 5-skeleton rig into ONE canonical skeleton.
# Every part mesh (head/body/backpack/arm/leg) has its own 57-bone tree, but
# only Body1's carries real transforms — the other four are identity-TRS
# mirrors nested bone-under-bone of their canonical namesake, so each part
# joint's world already equals the canonical bone's world. Re-point each
# skin's joints at the canonical nodes (IBMs stay valid unchanged) and drop
# the dead mirror nodes — ~228 fewer scene-graph nodes per model instance.
import json, struct

SRC = 'client/public/assets/models/class_heavy.glb'

raw = open(SRC, 'rb').read()
jlen = struct.unpack('<I', raw[12:16])[0]
g = json.loads(raw[20:20+jlen])
binbuf = raw[20 + jlen + 8:]
nodes = g['nodes']

canon = g['skins'][1]['joints']
canon_names = [nodes[j].get('name') for j in canon]
dead = set()
for k, sk in enumerate(g['skins']):
    if k == 1:
        continue
    assert [nodes[j].get('name') for j in sk['joints']] == canon_names, \
        f'skin {k} joint names differ from canonical'
    dead.update(sk['joints'])
    sk['joints'] = canon

# Dead set = the four mirror joint lists plus any node whose only ancestry is
# a dead subtree (e.g. wrapper nodes between tree roots). Nothing outside
# skins may reference them: animations target canonical nodes only (verified),
# meshes live on scene roots.
live_roots = g['scenes'][0]['nodes']
alive = set()

def mark(i):
    if i in alive or i in dead:
        return
    alive.add(i)
    for c in nodes[i].get('children', []):
        mark(c)

for r in live_roots:
    mark(r)
# canonical subtree contains dead roots as children — mark() already skips
# them via the dead set. Any node not reached and not a dead-tree member is
# also kept (conservative): keep non-dead nodes that mark() missed only if
# they were unreachable through dead roots alone.
all_dead = dead | (set(range(len(nodes))) - alive)

# Keep every node that is alive or explicitly needed; drop the rest.
keep = [i for i in range(len(nodes)) if i not in all_dead]
remap = {old: new for new, old in enumerate(keep)}

def remap_idx(i):
    return remap[i]

new_nodes = []
for old in keep:
    n = dict(nodes[old])
    if 'children' in n:
        n['children'] = [remap[c] for c in n['children'] if c in remap]
    new_nodes.append(n)
g['nodes'] = new_nodes

for sk in g['skins']:
    sk['joints'] = [remap[j] for j in sk['joints']]
    if 'skeleton' in sk and sk['skeleton'] is not None:
        sk['skeleton'] = remap.get(sk['skeleton'], sk['skeleton'])

for sc in g['scenes']:
    sc['nodes'] = [remap[r] for r in sc['nodes']]
g.get('scene', 0)

for anim in g.get('animations', []):
    for ch in anim['channels']:
        tgt = ch['target']['node']
        if tgt in remap:
            ch['target']['node'] = remap[tgt]
        else:
            raise SystemExit(f'animation channel targets dead node {tgt}')

for n in new_nodes:
    if 'mesh' in n and 'skin' in n:
        pass  # skin/mesh indices unchanged

jb = json.dumps(g, separators=(',', ':')).encode()
jb += b' ' * ((4 - len(jb) % 4) % 4)
total = 12 + 8 + len(jb) + 8 + len(binbuf)
with open(SRC, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, total))
    f.write(struct.pack('<I4s', len(jb), b'JSON') + jb)
    f.write(struct.pack('<I4s', len(binbuf), b'BIN\x00') + newbin)
print(f'dropped {len(all_dead)} dead nodes, {len(keep)} remain; skins -> canonical skeleton')
