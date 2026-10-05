#!/usr/bin/env python3
"""Tribes-style CTF map generator: emits maps/<name>.json with two mirrored
base compounds on a heightmap. Layout per base (heading faces midfield):

   midfield
      |
  [flag pedestal + step stones]  <- flag stand on a plinth
      |
 [flank walls]                  <- cover panels along the approach
      |
  [MAIN BASE]  = 4 walls w/ doorway gaps, slab roof, 26x16x7
      |
 [tower pillar + crow's platform]  <- 24m watch perch w/ parapet
 [annex hut]               <- gen/inventory shack

Collider reality: structureColliders is a YAW-ONLY OBB set — a 'ramp'
pitches its MESH but collides as an untilted box, so ramps are never
usable slopes; emit grounded boxes/walls instead.

Grounding: pos.y is the piece BASE, and the map is a rough heightfield,
so every piece sits at the LOWEST ground under its footprint — burying
the high side always reads better than a floating edge. dy still stacks
on top of that (roof slabs, parapets).

Yaw semantics (THREE rotation.y): local +Z maps to (sin r, cos r) in XZ,
local +X to (cos r, -sin r). A wall's long axis is whichever size is
biggest; align pieces with yaw(dx, dz) against the local approach frame.
"""
import json, math, sys

WORLD = 1500.0
SINK = 0.5

def load_hmap(path):
    d = open(path, 'rb').read()
    n = int(len(d) ** 0.5)
    return d, n

def ground(d, n, wx, wz):
    u = ((wx / WORLD) % 1.0) * n - 0.5
    v = ((wz / WORLD) % 1.0) * n - 0.5
    return d[(int(math.floor(v)) % n) * n + (int(math.floor(u)) % n)] / 255 * 125

def footprint_min(d, n, wx, wz, sx, sz, rotY):
    """Lowest ground under the piece's rotated AABB (center + corners) —
    grounding at the piece center on a slope leaves the ends airborne."""
    c = math.cos(rotY or 0); s = math.sin(rotY or 0)
    g = ground(d, n, wx, wz)
    for ox, oz in ((sx / 2, sz / 2), (-sx / 2, sz / 2), (sx / 2, -sz / 2), (-sx / 2, -sz / 2)):
        g = min(g, ground(d, n, wx + ox * c + oz * s, wz - ox * s + oz * c))
    return g

def yaw(dx, dz):
    """rotY aligning local +Z with world dir (dx, dz) — the pitch axis the
    ramp mesh and long-axis walls live on."""
    return math.atan2(dx, dz)

def piece(d, n, kind, wx, wz, sx, sy, sz, rotY=None, team=None, dy=0.0):
    p = {"kind": kind,
         "pos": {"x": round(wx, 1), "y": round(footprint_min(d, n, wx, wz, sx, sz, rotY) - SINK + dy, 2), "z": round(wz, 1)},
         "size": {"x": sx, "y": sy, "z": sz}}
    if rotY is not None: p["rotY"] = round(rotY, 4)
    if team: p["team"] = team
    return p

def wall_run(d, n, x0, z0, x1, z1, h, thick, team):
    """A wall from (x0,z0) to (x1,z1), split into <=9m segments so each
    piece grounds itself on sloped terrain instead of bridging it."""
    dx, dz = x1 - x0, z1 - z0
    length = math.hypot(dx, dz)
    segs = max(1, math.ceil(length / 9))
    out = []
    r = yaw(dx, dz)
    for i in range(segs):
        t0, t1 = i / segs, (i + 1) / segs
        mx, mz = x0 + dx * (t0 + t1) / 2, z0 + dz * (t0 + t1) / 2
        out.append(piece(d, n, 'wall', mx, mz, thick, h, length / segs + 0.4, rotY=r, team=team))
    return out

def compound(d, n, cx, cz, heading, team):
    """cx,cz = flag pedestal spot. heading = radians, fwd axis toward midfield.
    Local frame: fwd = toward midfield, rgt = perpendicular."""
    fx, fz = math.cos(heading), math.sin(heading)
    rx, rz = -fz, fx
    def at(fwd, rgt): return cx + fx * fwd + rx * rgt, cz + fz * fwd + rz * rgt
    fwd_yaw = yaw(fx, fz)          # rotY aligning +Z with the approach axis
    rgt_yaw = yaw(rx, rz)          # +Z running across the approach
    out = []

    # --- flag pedestal: plinth top lands on the flag home (~ground+1.4) ---
    out.append(piece(d, n, 'box', cx, cz, 8, 2.4, 8, team=team))
    # step stones on the approach side — low hop-up, not a fake ramp
    sx_, sz_ = at(6.2, 0)
    out.append(piece(d, n, 'box', sx_, sz_, 4, 0.8, 4, team=team))
    sx_, sz_ = at(4.4, 0)
    out.append(piece(d, n, 'box', sx_, sz_, 4, 1.6, 4, team=team))
    # flank panels beside the stand — long axis along the approach
    for sgn in (-1, 1):
        wx, wz = at(3, sgn * 8)
        out.append(piece(d, n, 'wall', wx, wz, 1.0, 3.2, 10, rotY=fwd_yaw + sgn * 0.5, team=team))

    # --- main base shell: ~20m behind the stand ---------------------------
    W, D, H, T = 26, 16, 7, 1.2   # width, depth, height, wall thickness
    DOOR = 5.0                    # front doorway gap
    bx, bz = at(-20, 0)           # shell center
    # walls as endpoint-to-endpoint runs — each segment grounds itself
    fwx, fwz = at(-20 + D / 2, 0)  # front wall line
    bwx, bwz = at(-20 - D / 2, 0)  # back wall line
    # front: two runs leaving the center door
    out += wall_run(d, n, fwx - rx * W / 2, fwz - rz * W / 2,
                    fwx - rx * DOOR / 2, fwz - rz * DOOR / 2, H, T, team)
    out += wall_run(d, n, fwx + rx * DOOR / 2, fwz + rz * DOOR / 2,
                    fwx + rx * W / 2, fwz + rz * W / 2, H, T, team)
    # back wall solid
    out += wall_run(d, n, bwx - rx * W / 2, bwz - rz * W / 2,
                    bwx + rx * W / 2, bwz + rz * W / 2, H, T, team)
    # side walls — rear corner gaps are the second entrances
    for sgn in (-1, 1):
        s0x, s0z = at(-20 - D / 2 + 6, sgn * W / 2)
        s1x, s1z = at(-20 + D / 2, sgn * W / 2)
        out += wall_run(d, n, s0x, s0z, s1x, s1z, H, T, team)
    # roof slab + interior divider (gen room — two rooms per Tribes rule)
    out.append(piece(d, n, 'box', bx, bz, W + 1, 1.0, D + 1, team=team, dy=H))
    out.append(piece(d, n, 'wall', bx, bz, T, H, D - 8, rotY=fwd_yaw, team=team))

    # --- watch tower: pillar + platform + parapet standing ON the slab ---
    tx, tz = at(-34, 12)
    out.append(piece(d, n, 'pillar', tx, tz, 4.0, 24, 4.0, team=team))
    out.append(piece(d, n, 'box', tx, tz, 11, 1.0, 11, team=team, dy=24))
    # parapet ring — dy 25 puts the walls on TOP of the platform slab
    # (platform pos.y = footprint min - SINK + 24, slab top = min + 24.5),
    # not half-buried inside it; the platform is flat so single pieces do
    for sgn in (-1, 1):
        wx, wz = at(-34, 12 + sgn * 5.5)
        out.append(piece(d, n, 'wall', wx, wz, 0.8, 1.6, 11, rotY=fwd_yaw, team=team, dy=25))
        wx, wz = at(-34 + sgn * 5.5, 12)
        out.append(piece(d, n, 'wall', wx, wz, 0.8, 1.6, 11, rotY=rgt_yaw, team=team, dy=25))

    # --- annex hut (gen shack) -------------------------------------------
    ax, az = at(-12, -14)
    out.append(piece(d, n, 'box', ax, az, 9, 6, 9, team=team))

    # --- scattered midfield-side cover ------------------------------------
    for i, (fd, rg, k) in enumerate([(16, 10, 'pillar'), (22, -6, 'wall'), (30, 6, 'pillar'), (14, -10, 'pillar')]):
        wx, wz = at(fd, rg)
        if k == 'pillar':
            out.append(piece(d, n, 'pillar', wx, wz, 2.4, 7 + i, 2.4))
        else:
            wx0, wz0 = at(fd, rg - 4); wx1, wz1 = at(fd, rg + 4)
            out += wall_run(d, n, wx0, wz0, wx1, wz1, 3.0, 1.0, team)
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

def spawn_pt(d, n, bx, bz, heading, fwd, rgt):
    """Spawn spots in the base's LOCAL frame — world +X offsets land inside
    walls whenever the heading isn't axis-aligned."""
    fx, fz = math.cos(heading), math.sin(heading)
    rx_, rz_ = -fz, fx
    x = bx + fx * fwd + rx_ * rgt
    z = bz + fz * fwd + rz_ * rgt
    return {"x": round(x, 1), "y": round(ground(d, n, x, z) + 1.2, 1), "z": round(z, 1)}

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
        # Two spawns beside the plinth, out the flank — never inside a wall
        "spawns": [
            spawn_pt(d, n, ax, az, head_a, -6, 10),
            spawn_pt(d, n, ax, az, head_a, -4, -10),
            spawn_pt(d, n, bx, bz, head_b, -6, 10),
            spawn_pt(d, n, bx, bz, head_b, -4, -10),
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
