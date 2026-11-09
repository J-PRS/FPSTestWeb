#!/usr/bin/env python3
"""q3tex — resolve Quake3 .map shader names to web-ready PNG textures.

Scans .map files for surface names, resolves them through Q3 shader
scripts (.shader) to a diffuse image, converts tga/jpg/png/pcx to PNG,
and writes:

  maps/t2/q3tex/<sha1>.png      converted images (content-addressed)
  maps/t2/q3tex/index.json      { "<map shader name>": {"f","w","h"} | null }

Sources, lowest→highest precedence:
  OpenArena pak0.pk3 + pak6-patch088.pk3 scripts (GPLv2)
  _reference/oacmpvol1/baseoa/scripts + textures (GPLv2, map-pack custom)
Images: oacmpvol1/baseoa/textures loose files, then pak6-patch088.pk3,
pak4-textures.pk3, pak0.pk3.
"""
import hashlib
import io
import json
import os
import re
import sys
import zipfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OACMP = os.path.join(ROOT, '_reference', 'oacmpvol1')
OA = os.path.join(ROOT, '_reference', 'openarena', 'openarena-0.8.8', 'baseoa')
OUT = os.path.join(ROOT, 'maps', 't2', 'q3tex')

PK3S = [
    os.path.join(OA, 'pak0.pk3'),
    os.path.join(OA, 'pak6-patch088.pk3'),
    os.path.join(OA, 'pak4-textures.pk3'),
    os.path.join(OA, 'pak1-maps.pk3'),
    os.path.join(OA, 'pak5-TA.pk3'),
    os.path.join(OA, 'pak6-misc.pk3'),
]
MP_PAK0 = os.path.join(OA, '..', 'missionpack', 'mp-pak0.pk3')
LOOSE_TEX = os.path.join(OACMP, 'baseoa', 'textures')
LOOSE_SCRIPTS = os.path.join(OACMP, 'baseoa', 'scripts')

EXTS = ['tga', 'jpg', 'jpeg', 'png', 'pcx']


def parse_shaders(text):
    """Yield (shader_name, first_map_path_or_None) from a .shader file."""
    # shader blocks: name on its own line, then { ... } possibly nested stages
    for m in re.finditer(r'(?m)^\s*([A-Za-z0-9_./\-]+)\s*\r?\n\s*\{', text):
        name = m.group(1)
        # find matching close brace
        i = m.end() - 1
        depth = 0
        j = i
        while j < len(text):
            if text[j] == '{':
                depth += 1
            elif text[j] == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        body = text[i:j]
        # first 'map <path>' inside a stage block (ignore shader-level keys —
        # 'map' only appears inside {} stages anyway)
        mm = re.search(r'\bmap\s+([A-Za-z0-9_./\-]+)', body)
        yield name, (mm.group(1) if mm else None)


def build_shader_db():
    db = {}
    # pk3 scripts in order (later wins)
    for pk3 in PK3S[:2]:
        if not os.path.exists(pk3):
            continue
        z = zipfile.ZipFile(pk3)
        lower = {n.lower(): n for n in z.namelist()}
        for n in z.namelist():
            if n.startswith('scripts/') and n.lower().endswith('.shader'):
                try:
                    text = z.read(n).decode('utf8', 'replace')
                except Exception:
                    continue
                for name, img in parse_shaders(text):
                    db[name.lower()] = img
        z.close()
    # loose oacmp scripts win
    if os.path.isdir(LOOSE_SCRIPTS):
        for fn in os.listdir(LOOSE_SCRIPTS):
            if not fn.lower().endswith('.shader'):
                continue
            text = open(os.path.join(LOOSE_SCRIPTS, fn), encoding='utf8', errors='replace').read()
            for name, img in parse_shaders(text):
                db[name.lower()] = img
    return db


IMG_PKS = [p for p in PK3S[1:] + [MP_PAK0] if os.path.exists(p)]


def find_image(path):
    """path like 'textures/foo/bar' → bytes or None."""
    rel = path.lower()
    sub = rel[len('textures/'):] if rel.startswith('textures/') else rel
    # loose oacmp textures first (map-pack overrides; dir IS textures/)
    for ext in EXTS:
        p = os.path.join(LOOSE_TEX, sub + '.' + ext)
        if os.path.exists(p):
            return open(p, 'rb').read()
    # pk3s
    for pk3 in IMG_PKS:
        z = zipfile.ZipFile(pk3)
        lower = {n.lower(): n for n in z.namelist()}
        for cand in (rel, 'textures/' + sub):
            for ext in EXTS:
                actual = lower.get((cand + '.' + ext).lower())
                if actual:
                    data = z.read(actual)
                    z.close()
                    return data
        z.close()
    return None


def scan_map_shaders(map_paths):
    used = set()
    plane_re = re.compile(r'\(\s*[-\d.eE+]+\s+[-\d.eE+]+\s+[-\d.eE+]+\s*\)\s*'
                          r'\(\s*[-\d.eE+]+\s+[-\d.eE+]+\s+[-\d.eE+]+\s*\)\s*'
                          r'\(\s*[-\d.eE+]+\s+[-\d.eE+]+\s+[-\d.eE+]+\s*\)\s*'
                          r'([A-Za-z0-9_./\-]+)')
    for mp in map_paths:
        text = open(mp, encoding='utf8', errors='replace').read()
        for m in plane_re.finditer(text):
            used.add(m.group(1))
    return used


def main():
    maps = sys.argv[1:]
    if not maps:
        maps = [os.path.join(ROOT, '_reference', 'oacmpvol1', 'sources', 'maps', f)
                for f in os.listdir(os.path.join(ROOT, '_reference', 'oacmpvol1', 'sources', 'maps'))
                if f.endswith('.map')]
    print('scanning', len(maps), 'maps')
    used = scan_map_shaders(maps)
    print(len(used), 'shader names')

    db = build_shader_db()
    print(len(db), 'shader scripts')

    os.makedirs(OUT, exist_ok=True)
    index = {}
    ok = miss = 0
    for name in sorted(used):
        key = name.lower()
        if key.startswith('textures/'):
            key = key[len('textures/'):]
        img = db.get('textures/' + key) or db.get(key)
        if img is None:
            # implicit shader: try the name as an image directly
            img = 'textures/' + key
        data = find_image(img) if img else None
        if data is None:
            index[key] = None
            miss += 1
            continue
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
        except Exception as e:
            print('decode fail', key, img, e)
            index[key] = None
            miss += 1
            continue
        # downscale huge textures to 512 max — web perf, still sharp
        ow, oh = im.size
        if max(ow, oh) > 512:
            im.thumbnail((512, 512), Image.LANCZOS)
        fn = hashlib.sha1(data).hexdigest()[:16] + '.png'
        path = os.path.join(OUT, fn)
        if not os.path.exists(path):
            im.save(path, 'PNG', optimize=True)
        index[key] = {'f': fn, 'w': im.size[0], 'h': im.size[1], 'ow': ow, 'oh': oh}
        ok += 1
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump(index, f, indent=0, sort_keys=True)
    print(f'{ok} textured, {miss} unresolved -> {OUT}')


if __name__ == '__main__':
    main()
