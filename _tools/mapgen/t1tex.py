#!/usr/bin/env python3
"""Tribes 1 terrain textures + sky dome -> our map assets.

The T1 port (t1import.py) brought over the HEIGHTFIELD only: the ground
rendered with our procedural terrain palette. T1's real look lives in the
DML palette + the per-cell material map inside the .ted, so this tool
bakes those into the same assets the T2 ports ship:

  maps/t1/<name>_t1/albedo.webp          baked terrain albedo (2048^2)
  maps/t1/<name>_t1/sky/{px,nx,py,ny,pz,nz}.webp   sky cube faces
  maps/<name>_t1.json                   + terrainTex / sky fields

T1 has no cubemap skybox: its sky is a 16-wedge dome (each wedge a
zenith->horizon strip) with the wedge->texture index in the mission's
Sky object. We resample that dome into a cube.

Orientation: the material map is decoded in the same row order as the
heightmap, so it must carry the SAME dihedral flip the heightmap got.
Rather than re-derive the flip, we match the decoded heightmap against
the SHIPPED maps/t1/<name>_t1/terrain.bin - the shipped bin is the truth
the game already renders, so the albedo lands pixel-aligned with it.

Usage: python t1tex.py <map> [<map> ...] [--res 2048] [--no-sky]
"""
import io
import json
import os
import re
import struct
import sys
import zipfile

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from t1terrain import terrain as _terrain  # noqa: E402
from t1terrain import dml as _dml  # noqa: E402

T1_ROOT = os.environ.get('T1_ROOT', r'C:\Users\JPrice\Downloads\[Tribes 1]\Tribes 2015')
T1_BASE = os.path.join(T1_ROOT, 'base')
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))

# Terrain palette zip per DML palette name (the .dtf names the palette).
PAL_ZIP = {
    'lush': 'lushTerrain.zip', 'ice': 'iceTerrain.zip', 'desert': 'desertTerrain.zip',
    'mars': 'marsTerrain.zip', 'mud': 'mudTerrain.zip', 'savana': 'savanaDML.zip',
    'alien': 'alienTerrain.zip', 'titan': 'titanDML.zip',
}
# Zips that carry the terrain material textures (the DML palettes reference
# .bmp names; the shipped files are the same images as .png).
TEX_ZIPS = ['lushDML.zip', 'iceDML.zip', 'desertDML.zip', 'marsDML.zip', 'mudDML.zip',
            'savanaDML.zip', 'alienDML.zip', 'titanDML.zip']
# Zips that carry the sky dome wedges.
WORLD_ZIPS = ['lushWorld.zip', 'iceWorld.zip', 'desertWorld.zip', 'marsWorld.zip',
              'mudWorld.zip', 'alienWorld.zip', 'marsWorld2.zip']

FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz']


# ---------------------------------------------------------------- helpers
def find_mis(name):
    for sub in ('base\\missions', 'balanced\\missions'):
        p = os.path.join(T1_ROOT, sub, name + '.mis')
        if os.path.exists(p):
            return p
    return None


def zread(zp, member):
    """Case-insensitive member read from a zip; None when absent."""
    try:
        z = zipfile.ZipFile(os.path.join(T1_BASE, zp))
    except (OSError, KeyError):
        return None
    with z:
        low = member.lower()
        for n in z.namelist():
            if n.lower() == low:
                return z.read(n)
    return None


def build_tex_index():
    """lower(name) -> (zip, member) for every texture-bearing zip."""
    idx = {}
    for zp in TEX_ZIPS + WORLD_ZIPS:
        try:
            z = zipfile.ZipFile(os.path.join(T1_BASE, zp))
        except (OSError, KeyError):
            continue
        with z:
            for n in z.namelist():
                idx.setdefault(n.lower(), (zp, n))
    return idx


def orient(a, flip):
    """Dihedral flip shared with t1import.calibrate - same transform."""
    h = a
    if flip & 1:
        h = h[::-1, :]
    if flip & 2:
        h = h[:, ::-1]
    if flip & 4:
        h = h.T.copy()
    return h


def decode_ted(ted_path):
    z = zipfile.ZipFile(ted_path)
    with z:
        names = z.namelist()
        dtf = [n for n in names if n.lower().endswith('.dtf')]
        dtb = [n for n in names if n.lower().endswith('.dtb')]
        t = _terrain.terrain()
        if dtf:
            t.load_dtf_binary(z.read(dtf[0]))
        t.load_binary(z.read(dtb[0]))
    return t


def load_dml(zp, member):
    raw = zread(zp, member)
    if raw is None:
        return None
    d = _dml.dml()
    d.load_binary(raw)
    return d


def material_images(names, tex_index, wanted):
    """-> {mat index: PIL image} for the materials this map actually uses."""
    out = {}
    for i in wanted:
        if i >= len(names):
            continue
        mn = names[i]
        if not mn:
            continue
        key = mn.lower().replace('.bmp', '.png')
        hit = tex_index.get(key)
        if hit is None:
            continue
        raw = zread(hit[0], hit[1])
        if raw is None:
            continue
        try:
            out[i] = Image.open(io.BytesIO(raw)).convert('RGB')
        except OSError:
            continue
    return out


def match_flip(raw_hm, bin_path):
    """Which dihedral flip turns the decoded heightmap into the shipped
    bin? The bin is u8-quantized, so compare normalized values."""
    if not os.path.exists(bin_path):
        return None
    with open(bin_path, 'rb') as f:
        data = f.read()
    n = struct.unpack('<I', data[0:4])[0]
    shipped = np.frombuffer(data[8:8 + n * n], dtype=np.uint8).reshape(n, n).astype(np.float32)
    r = raw_hm[:n, :n]
    lo, hi = float(r.min()), float(r.max())
    if hi - lo < 1e-6:
        return (0.0, 0)
    best = None
    for flip in range(8):
        # orient the FULL vertex grid, then slice - flipping the slice
        # instead shifts every row by one (the 257th vertex row).
        u8 = np.clip((orient(raw_hm, flip)[:n, :n] - lo) / (hi - lo) * 255.0, 0, 255)
        err = float(np.abs(u8 - shipped).mean())
        if best is None or err < best[0]:
            best = (err, flip)
    return best


# ---------------------------------------------------------------- albedo
def bake_albedo(t, flip, images, res):
    """Per-cell material stamp -> albedo.

    T1 draws ONE material texture per 8m cell (rotated/flipped per cell
    by the cell's flag bits), so the bake stamps each cell with its
    material's texture, box-filtered down to the cell's pixel size.
    """
    n = t.size_x
    mat = orient(t.mat_index, flip)
    flags = orient(t.mat_flags, flip)
    cell = res // n
    out = np.zeros((res, res, 3), dtype=np.float32)
    cache = {}
    for y in range(n):
        for x in range(n):
            mi = int(mat[y, x])
            img = images.get(mi)
            if img is None:
                continue
            key = (mi, int(flags[y, x]) & 7)
            tile = cache.get(key)
            if tile is None:
                f = key[1]
                t_img = img
                if f & 2:
                    t_img = t_img.transpose(Image.FLIP_TOP_BOTTOM)
                if f & 4:
                    t_img = t_img.transpose(Image.FLIP_LEFT_RIGHT)
                if f & 1:
                    t_img = t_img.transpose(Image.ROTATE_270)
                tile = np.asarray(t_img.resize((cell, cell), Image.BOX), dtype=np.float32)
                cache[key] = tile
            out[y * cell:(y + 1) * cell, x * cell:(x + 1) * cell] = tile
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


# ---------------------------------------------------------------- sky
def sky_block(mis_text):
    """-> the mission's Sky object body, or None."""
    m = re.search(r'instant\s+Sky\s+"[^"]*"\s*\{', mis_text)
    if not m:
        return None
    depth = 0
    end = len(mis_text)
    for i in range(m.end() - 1, len(mis_text)):
        if mis_text[i] == '{':
            depth += 1
        elif mis_text[i] == '}':
            depth -= 1
            if depth == 0:
                end = i
                break
    return mis_text[m.start():end]


def sky_wedges(mis_text, tex_index):
    """-> (list of 16 PIL images, one per dome sector) or None.

    T1's Sky object: textures[0..15] names the DML material for each of
    the 16 dome sectors. A map with no dmlName has no dome art at all
    (T1 drew a flat sky colour there).
    """
    block = sky_block(mis_text)
    if block is None:
        return None
    dm = re.search(r'dmlName\s*=\s*"([^"]*)"', block)
    dml_name = dm.group(1) if dm else ''
    if not dml_name:
        return None
    slots = [int(v) for v in re.findall(r'textures\[\d+\]\s*=\s*"(\d+)"', block)]
    if len(slots) < 16:
        return None
    d = None
    for zp in WORLD_ZIPS:
        d = load_dml(zp, dml_name)
        if d is not None:
            break
    if d is None:
        return None
    names = [m.name for m in d.materials]
    wedges = []
    for s in slots:
        idx = s % len(names) if names else 0
        nm = names[idx] if names else ''
        img = None
        if nm:
            hit = tex_index.get(nm.lower().replace('.bmp', '.png'))
            if hit:
                raw = zread(hit[0], hit[1])
                if raw:
                    try:
                        img = Image.open(io.BytesIO(raw)).convert('RGB')
                    except OSError:
                        img = None
        wedges.append(img)
    return wedges


def dome_to_cube(wedges, size=512, offset_deg=0.0):
    """16 zenith->horizon wedges -> GL cube faces (px,nx,py,ny,pz,nz).

    Each wedge is a linear lat/long strip: x = azimuth inside its 22.5
    sector, y = zenith(row 0) -> nadir(bottom row) over 180 degrees, so
    the horizon sits at the middle of the strip. Cube texels are sampled
    from the dome by their direction vector, so the cloud band lands in
    the right place instead of being pasted.
    """
    SEC = 360.0 / 16
    s = np.linspace(-1, 1, size)
    t = np.linspace(-1, 1, size)
    SS, TT = np.meshgrid(s, t)
    specs = {
        'px': (np.ones_like(SS), -TT, -SS),
        'nx': (-np.ones_like(SS), -TT, SS),
        'py': (SS, np.ones_like(SS), TT),
        'ny': (SS, -np.ones_like(SS), -TT),
        'pz': (SS, -TT, np.ones_like(SS)),
        'nz': (-SS, -TT, -np.ones_like(SS)),
    }
    out = {}
    for name, (dx, dy, dz) in specs.items():
        az = (np.degrees(np.arctan2(dx, dz)) + offset_deg) % 360.0
        el = np.degrees(np.arcsin(np.clip(dy, -1.0, 1.0)))
        sector = np.minimum((az / SEC).astype(np.int32), 15)
        colf = az / SEC - sector
        rowf = np.clip((90.0 - el) / 180.0, 0.0, 1.0)
        face = np.zeros((size, size, 3), dtype=np.float32)
        for sec in range(16):
            img = wedges[sec]
            if img is None:
                continue
            w, h = img.size
            arr = np.asarray(img, dtype=np.float32)[:, :, :3]
            m = sector == sec
            if not m.any():
                continue
            xf = (colf[m] * (w - 1)).astype(np.int32)
            yf = (rowf[m] * (h - 1)).astype(np.int32)
            x1 = np.minimum(xf + 1, w - 1)
            y1 = np.minimum(yf + 1, h - 1)
            fx = (colf[m] * (w - 1)) - xf
            fy = (rowf[m] * (h - 1)) - yf
            a, b = arr[yf, xf], arr[yf, x1]
            c, d = arr[y1, xf], arr[y1, x1]
            face[m] = (a * ((1 - fx) * (1 - fy))[:, None] + b * (fx * (1 - fy))[:, None]
                       + c * ((1 - fx) * fy)[:, None] + d * (fx * fy)[:, None])
        out[name] = Image.fromarray(np.clip(face, 0, 255).astype(np.uint8))
    return out


# ---------------------------------------------------------------- driver
def main():
    args = sys.argv[1:]
    res = 2048
    if '--res' in args:
        res = int(args[args.index('--res') + 1])
    no_sky = '--no-sky' in args
    names = [a for a in args if not a.startswith('--') and not a.isdigit()]

    tex_index = build_tex_index()
    for name in names:
        mis = find_mis(name)
        if not mis:
            print(f'{name}: no .mis under {T1_ROOT}')
            continue
        ted = os.path.splitext(mis)[0] + '.ted'
        if not os.path.exists(ted):
            print(f'{name}: no .ted')
            continue
        t = decode_ted(ted)
        pal = (t.dml_name or b'').decode('latin-1').split('.')[0].lower()
        # The repo's T1 ports are suffixed _t1 (maps/t1/<name>_t1/).
        slug = name if name.endswith('_t1') else f'{name}_t1'
        out_dir = os.path.join(REPO, 'maps', 't1', slug)
        os.makedirs(out_dir, exist_ok=True)
        m = match_flip(t.heightmap, os.path.join(out_dir, 'terrain.bin'))
        if m is None:
            print(f'{name}: no shipped terrain.bin to align against')
            continue
        err, flip = m
        print(f'{name}: palette={pal} grid={t.size_x}x{t.size_y} flip={flip} '
              f'(heightmap match err {err:.2f}/255)')
        if err > 6.0:
            print('   !! heightmap match is poor - refusing to bake')
            continue

        spec_path = os.path.join(REPO, 'maps', f'{slug}.json')
        spec = {}
        if os.path.exists(spec_path):
            with open(spec_path, encoding='utf-8') as f:
                spec = json.load(f)

        # --- terrain albedo ---
        pz = PAL_ZIP.get(pal)
        d = load_dml(pz, pal + '.dml') if pz else None
        if d is None:
            print(f'   no palette for {pal}')
            continue
        mat_names = [mm.name for mm in d.materials]
        used = sorted(set(t.mat_index.ravel().tolist()))
        images = material_images(mat_names, tex_index, used)
        print(f'   materials {len(used)} used, {len(images)} textures resolved')
        albedo = bake_albedo(t, flip, images, res)
        albedo_path = os.path.join(out_dir, 'albedo.webp')
        albedo.save(albedo_path, 'WEBP', quality=90, method=6)
        print(f'   wrote {albedo_path} ({os.path.getsize(albedo_path) // 1024} KB)')
        spec['terrainTex'] = f't1/{slug}/albedo.webp'

        # --- sky dome ---
        if not no_sky:
            mis_text = open(mis, encoding='latin-1').read()
            wedges = sky_wedges(mis_text, tex_index)
            if wedges and any(w is not None for w in wedges):
                faces = dome_to_cube(wedges, size=512)
                sky_dir = os.path.join(out_dir, 'sky')
                os.makedirs(sky_dir, exist_ok=True)
                for f in FACE_ORDER:
                    faces[f].save(os.path.join(sky_dir, f'{f}.webp'), 'WEBP',
                                  quality=88, method=6)
                spec['sky'] = f't1/{slug}/sky'
                print(f'   wrote sky cube ({sum(w is not None for w in wedges)}/16 wedges)')
            else:
                spec.pop('sky', None)
                print('   no sky dome art in this mission (flat sky colour)')

        with open(spec_path, 'w', encoding='utf-8') as f:
            json.dump(spec, f, indent=2)
        print(f'   patched {spec_path}')


if __name__ == '__main__':
    main()
