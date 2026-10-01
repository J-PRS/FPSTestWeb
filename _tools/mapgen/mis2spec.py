#!/usr/bin/env python3
"""Tribes 2 .mis -> our map spec JSON.

Parses a real T2 mission file and emits the pieces our MapSpec understands:
  - InteriorInstance  -> `interiors` (file basename, pos, T2 axis-angle rot, scale)
  - StaticShape/Turret with a datablock -> `_assets` (generator, inventory
    station, flag stand, turret, sensor...) with its team from the enclosing
    SimGroup(Team1|Team2) — placement hints for the base-asset system.
  - SpawnSphere inside team groups -> `teamSpawns`; ungrouped -> `spawns`
  - Item dataBlock="Flag" -> `bases` (flag stand = base anchor)
  - MissionArea -> `arena`

Objects are parsed with real brace matching so team attribution comes from
the enclosing SimGroup, not field order.

Usage: python3 mis2spec.py <in.mis> [<out.json>] [--merge maps/<name>.json]
"""
import json
import re
import sys

OBJ_RE = re.compile(r'new\s+(\w+)\s*\(\s*"?([^")]*)?"?\s*\)\s*\{')
FIELD_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"\s*;')
BARE_FIELD_RE = re.compile(r'(\w+)\s*=\s*([^;"\s][^;]*)\s*;')


def match_brace(src, open_idx):
    """Index just past the closing '};' for the brace at open_idx."""
    depth = 0
    for i in range(open_idx, len(src)):
        c = src[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i + 1
    return len(src)


def parse_fields(block):
    out = {}
    for m in FIELD_RE.finditer(block):
        out[m.group(1)] = m.group(2)
    for m in BARE_FIELD_RE.finditer(block):
        out.setdefault(m.group(1), m.group(2).strip())
    return out


def parse_objs(src, start=0, end_limit=None, team=None):
    """Yield (cls, name, fields, team) recursively; team = enclosing
    SimGroup(TeamN). Non-SimGroup objects yield themselves only."""
    pos = start
    limit = end_limit if end_limit is not None else len(src)
    while True:
        m = OBJ_RE.search(src, pos)
        if not m or m.start() >= limit:
            return
        open_brace = src.index('{', m.end() - 1)
        end = match_brace(src, open_brace)
        body = src[open_brace + 1: end - 1]
        cls, name = m.group(1), (m.group(2) or '').strip()
        if cls == 'SimGroup':
            t = team
            if name in ('Team1', 'Team2'):
                t = 'alpha' if name == 'Team1' else 'bravo'
            yield from parse_objs(src, open_brace + 1, end - 1, t)
        else:
            yield cls, name, parse_fields(body), team
        pos = end


def vec(s, n=3):
    p = (s or '').split()
    try:
        vals = [float(x) for x in p[:n]]
    except ValueError:
        vals = []
    while len(vals) < n:
        vals.append(0.0)
    return vals


XZ_S = 1500.0 / 2048.0        # world horizontal squash (matches ter2bin)
HEIGHT_M = 125.0              # our terrain's full-relief height


def load_ter(path):
    """Torque TerrainFile v2: 1-byte version + 256x256 u16 heights in
    11.5 fixed-point (meters = raw/32), 8m grid over a 2048m tile."""
    import array, math
    raw = open(path, 'rb').read()
    hm = array.array('H')
    hm.frombytes(raw[1:1 + 256 * 256 * 2])
    def at(x, y):
        u = (x / 2048.0 + 0.5) * 256 - 0.5
        v = (y / 2048.0 + 0.5) * 256 - 0.5
        x0, y0 = int(math.floor(u)) % 256, int(math.floor(v)) % 256
        fx, fy = u - math.floor(u), v - math.floor(v)
        x1, y1 = (x0 + 1) % 256, (y0 + 1) % 256
        g = (hm[y0 * 256 + x0] * (1 - fx) * (1 - fy) + hm[y0 * 256 + x1] * fx * (1 - fy)
             + hm[y1 * 256 + x0] * (1 - fx) * fy + hm[y1 * 256 + x1] * fx * fy)
        return g / 32.0
    vals = [hm[i] / 32.0 for i in range(256 * 256)]
    return at, min(vals), max(vals) - min(vals)


def load_bin(path):
    """Our heightfield: u32 w,h + u8 grid, 0..255 -> 0..125m over 1500m."""
    import math, struct
    d = open(path, 'rb').read()
    w, h = struct.unpack('<II', d[:8])
    b = d[8:]
    def at(wx, wz):
        u = ((wx / 1500.0) % 1.0) * w - 0.5
        v = ((wz / 1500.0) % 1.0) * h - 0.5
        x0, z0 = int(math.floor(u)) % w, int(math.floor(v)) % h
        fx, fz = u - math.floor(u), v - math.floor(v)
        x1, z1 = (x0 + 1) % w, (z0 + 1) % h
        g = (b[z0 * w + x0] * (1 - fx) * (1 - fz) + b[z0 * w + x1] * fx * (1 - fz)
             + b[z1 * w + x0] * (1 - fx) * fz + b[z1 * w + x1] * fx * fz)
        return g / 255.0 * HEIGHT_M
    return at


def main():
    src = open(sys.argv[1], encoding='latin-1').read()

    # Height mapping: preserve each object's authored offset ABOVE ITS OWN
    # T2 ground, re-expressed against OUR terrain. The .bin was re-based
    # at port time (not a pure linear normalize), so a global affine fit
    # mis-seats buildings by tens of meters; ground-relative is exact at
    # the anchor point and degrades gracefully on slopes.
    lo, relief = 0.0, 225.0
    t2_ground = None
    our_ground = None
    if '--ter' in sys.argv:
        t2_ground, lo, relief = load_ter(sys.argv[sys.argv.index('--ter') + 1])
    if '--bin' in sys.argv:
        our_ground = load_bin(sys.argv[sys.argv.index('--bin') + 1])
    HS = HEIGHT_M / relief

    def wpos(p):
        x, z = p[0] * XZ_S, p[1] * XZ_S
        if t2_ground and our_ground:
            y = our_ground(x, z) + (p[2] - t2_ground(p[0], p[1])) * HS
        else:
            y = (p[2] - lo) * HS
        return {'x': round(x, 2), 'y': round(y, 2), 'z': round(z, 2)}

    def wscale(s):
        # scale is applied in OUR axes after the Y/Z swap: our y gets the
        # T2 z component with the height factor.
        return {'x': round(s[0] * XZ_S, 3), 'y': round(s[2] * HS, 3), 'z': round(s[1] * XZ_S, 3)}

    interiors = []
    assets = []
    spawns = []
    team_spawns = {'alpha': [], 'bravo': []}
    bases = {}
    arena = None

    for cls, name, f, team in parse_objs(src):
        pos = vec(f.get('position'))
        rot = vec(f.get('rotation'), 4)
        scale = vec(f.get('scale'))
        fn = f.get('interiorFile', f.get('filename', ''))
        if cls == 'InteriorInstance':
            if not fn.lower().endswith('.dif'):
                continue
            ent = {'file': fn.replace('\\', '/').split('/')[-1], 'pos': wpos(pos)}
            if any(abs(r) > 1e-6 for r in rot[:3]) or abs(rot[3]) > 1e-6:
                ent['rot'] = [round(r, 5) for r in rot]
            ent['scale'] = wscale(scale)  # always — carries the port squash
            interiors.append(ent)
        elif cls in ('StaticShape', 'Turret', 'Item') and f.get('dataBlock'):
            db = f['dataBlock']
            if db == 'Flag':
                if team:
                    wp = wpos(pos)
                    bases[team] = {'x': wp['x'], 'y': 0, 'z': wp['z']}
                continue
            assets.append({'name': name, 'datablock': db,
                           'file': fn.replace('\\', '/').split('/')[-1] if fn else None,
                           'team': team,
                           'pos': wpos(pos),
                           'rot': [round(r, 5) for r in rot]})
        elif cls == 'SpawnSphere':
            wp = wpos(pos)
            ent = {'x': wp['x'], 'y': 0, 'z': wp['z'],
                   'r': round(float(f.get('radius', '1') or 1) * XZ_S, 2)}
            w = f.get('sphereWeight')
            if w:
                ent['w'] = round(float(w), 2)
            if team:
                team_spawns[team].append(ent)
            else:
                spawns.append(ent)
        elif cls == 'MissionArea':
            area = vec(f.get('area'), 4)
            if area[0] or area[1]:
                arena = {'x': round((area[0] + area[2]) / 2 * XZ_S, 1),
                         'z': round((area[1] + area[3]) / 2 * XZ_S, 1),
                         'radius': round(max(area[2] - area[0], area[3] - area[1]) / 2 * XZ_S, 1)}

    out = {}
    if interiors: out['interiors'] = interiors
    if assets: out['_assets'] = assets
    if spawns: out['spawns'] = spawns
    if any(team_spawns.values()): out['teamSpawns'] = team_spawns
    if bases: out['bases'] = bases
    if arena: out['arena'] = arena

    if '--merge' in sys.argv:
        mp = sys.argv[sys.argv.index('--merge') + 1]
        cur = json.load(open(mp))
        cur.update(out)
        out = cur
        dest = mp
    else:
        dest = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else None

    text = json.dumps(out, indent=2)
    if dest:
        open(dest, 'w').write(text + '\n')
        print(f'wrote {dest}: {len(interiors)} interiors, {len(assets)} assets, '
              f'{len(spawns)} spawns, {sum(len(v) for v in team_spawns.values())} teamSpawns, bases={list(bases)}')
    else:
        print(text)


if __name__ == '__main__':
    main()
