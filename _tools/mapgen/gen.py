#!/usr/bin/env python3
"""Tribes-style CTF map generator: emits maps/<name>.json with two mirrored
base compounds on a heightmap. Layout per base (heading faces midfield):

   midfield
      |
  [flag pedestal]          <- flag stand on low plinth
      |
 [side walls + ramps]      <- cover around the stand
      |
  [MAIN BASE]  = 4 walls w/ doorway gaps, slab roof, 26x16x7
      |
 [tower pillar + crow's platform]  <- 24m watch perch w/ parapet
 [annex hut]               <- gen/inventory shack

Structures are cover, not collision (client renders, balls collide via
structureColliders). pos.y = sampled ground height - sink.
"""
import json, math, sys

WORLD = 1500.0
SINK = 1.0

def load_hmap(path):
    d = open(path, 'rb').read()
    n = int(len(d) ** 0.5)
    return d, n

def ground(d, n, wx, wz):
    u = ((wx / WORLD) % 1.0) * n - 0.5
    v = ((wz / WORLD) % 1.0) * n - 0.5
    return d[(int(math.floor(v)) % n) * n + (int(math.floor(u)) % n)] / 255 * 125

def piece(d, n, kind, wx, wz, sx, sy, sz, rotY=None, team=None, dy=0.0):
    p = {"kind": kind,
         "pos": {"x": round(wx, 1), "y": round(ground(d, n, wx, wz) - SINK + dy, 2), "z": round(wz, 1)},
         "size": {"x": sx, "y": sy, "z": sz}}
    if rotY: p["rotY"] = round(rotY, 4)
    if team: p["team"] = team
    return p

def compound(d, n, cx, cz, heading, team):
    """cx,cz = flag pedestal spot. heading = radians, +X axis toward midfield.
    Local frame: fwd = toward midfield, right = perpendicular."""
    fx, fz = math.cos(heading), math.sin(heading)
    rx, rz = -fz, fx
    def at(fwd, rgt): return cx + fx * fwd + rx * rgt, cz + fz * fwd + rz * rgt
    out = []

    # --- flag pedestal: 8x8 plinth, flag sits ~1.4m up -------------------
    out.append(piece(d, n, 'box', cx, cz, 8, 1.6, 8, team=team))
    # low cover ring: two angled walls flanking the stand, open front/back
    for sgn in (-1, 1):
        wx, wz = at(2, sgn * 8)
        out.append(piece(d, n, 'wall', wx, wz, 1.0, 3.2, 10, rotY=heading + sgn * 0.5, team=team))
    # ramp up the pedestal front so cappers slide onto it
    rx_, rz_ = at(6, 0)
    out.append(piece(d, n, 'ramp', rx_, rz_, 5, 2.4, 6, rotY=heading, team=team))

    # --- main base shell: ~18m behind the stand ---------------------------
    W, D, H, T = 26, 16, 7, 1.2   # width, depth, height, wall thickness
    # front wall split into two segments -> 5m doorway gap at center
    for sgn in (-1, 1):
        seg_off = sgn * (W / 4 + 2.5 / 2)
        wx, wz = at(-20 + D / 2, seg_off)
        out.append(piece(d, n, 'wall', wx, wz, W / 2 - 2.5, H, T, rotY=heading + math.pi / 2, team=team))
    # back wall solid
    wx, wz = at(-20 - D / 2, 0)
    out.append(piece(d, n, 'wall', wx, wz, W, H, T, rotY=heading + math.pi / 2, team=team))
    # side walls with a rear-side gap each (second entrance)
    for sgn in (-1, 1):
        wx, wz = at(-20, sgn * W / 2)
        out.append(piece(d, n, 'wall', wx, wz, D - 6, H, T, rotY=heading, team=team))
    # roof slab
    wx, wz = at(-20, 0)
    out.append(piece(d, n, 'box', wx, wz, W + 1, 1.0, D + 1, team=team, dy=H))
    # interior divider — the "gen room" wall (two rooms per Tribes rule)
    wx, wz = at(-20, 0)
    out.append(piece(d, n, 'wall', wx, wz, T, H, D - 8, rotY=heading, team=team))

    # --- watch tower: pillar + crow's nest platform + parapet ------------
    tx, tz = at(-34, 12)
    out.append(piece(d, n, 'pillar', tx, tz, 4.0, 24, 4.0, team=team))
    out.append(piece(d, n, 'box', tx, tz, 11, 1.0, 11, team=team, dy=24))
    # parapet ring on the platform edge
    for sgn in (-1, 1):
        wx, wz = at(-34, 12 + sgn * 5.5)
        out.append(piece(d, n, 'wall', wx, wz, 1.0, 1.6, 11, rotY=heading, team=team, dy=24))
        wx, wz = at(-34 + sgn * 5.5, 12)
        out.append(piece(d, n, 'wall', wx, wz, 11, 1.6, 1.0, rotY=heading + math.pi / 2, team=team, dy=24))
    # long ramp from base roofline area toward tower platform
    rx_, rz_ = at(-28, 8)
    out.append(piece(d, n, 'ramp', rx_, rz_, 4, 3.0, 12, rotY=heading + 0.6, team=team, dy=14))

    # --- annex hut (gen shack) -------------------------------------------
    ax, az = at(-12, -14)
    out.append(piece(d, n, 'box', ax, az, 9, 6, 9, team=team))
    out.append(piece(d, n, 'ramp', ax + fx * 7, az + fz * 7, 5, 2.6, 7, rotY=heading, team=team, dy=5.4))

    # --- scattered midfield-side cover ------------------------------------
    for i, (fd, rg, k) in enumerate([(16, 10, 'pillar'), (22, -6, 'wall'), (30, 6, 'pillar'), (14, -10, 'pillar')]):
        wx, wz = at(fd, rg)
        if k == 'pillar':
            out.append(piece(d, n, 'pillar', wx, wz, 2.4, 7 + i, 2.4))
        else:
            out.append(piece(d, n, 'wall', wx, wz, 1.0, 3.0, 9, rotY=heading + 0.9))
    return out

def midfield(d, n, ax, az, bx, bz):
    """Cover scattered between the two bases — midfield obstacles."""
    out = []
    mx, mz = (ax + bx) / 2, (az + bz) / 2
    rng = 9871
    def rnd():
        nonlocal rng; rng = (rng * 1103515245 + 12345) % 2**31; return rng / 2**31
    for i in range(7):
        t = 0.25 + 0.5 * rnd()
        x = ax + (bx - ax) * t + (rnd() - 0.5) * 90
        z = az + (bz - az) * t + (rnd() - 0.5) * 90
        out.append(piece(d, n, 'pillar', x, z, 3 + rnd() * 4, 8 + rnd() * 14, 3 + rnd() * 4))
    return out

def build(name, binname, alpha, bravo, bots=8, fill=10):
    d, n = load_hmap(f'maps/{binname}')
    ax, az = alpha; bx, bz = bravo
    head_a = math.atan2(bz - az, bx - ax)
    head_b = math.atan2(az - bz, ax - bx)
    ay = ground(d, n, ax, az) + 1.4   # flag stand top
    by = ground(d, n, bx, bz) + 1.4
    spec = {
        "mode": "ctf",
        "bots": bots,
        "botFill": fill,
        "terrain": binname,
        "bases": {
            "alpha": {"x": ax, "y": round(ay, 1), "z": az},
            "bravo": {"x": bx, "y": round(by, 1), "z": bz},
        },
        "spawns": [
            {"x": ax + 8, "y": round(ay, 1), "z": az},
            {"x": ax - 6, "y": round(ay, 1), "z": az + 8},
            {"x": bx + 8, "y": round(by, 1), "z": bz},
            {"x": bx - 6, "y": round(by, 1), "z": bz - 8},
        ],
        "structures": compound(d, n, ax, az, head_a, 'alpha')
                    + compound(d, n, bx, bz, head_b, 'bravo')
                    + midfield(d, n, ax, az, bx, bz),
    }
    json.dump(spec, open(f'maps/{name}.json', 'w'), indent=2)
    print(f"maps/{name}.json: {len(spec['structures'])} structures, flags y={ay:.0f}/{by:.0f}")

# henges pair was flattest: alpha(30,70) bravo(350,-50) on henge.bin
build('stonekeep', 'henge.bin', (30, 70), (350, -50))
# slagheap pair: alpha(-450,110) bravo(-370,350)
build('bastion', 'slagheap.bin', (-450, 110), (-370, 350))
