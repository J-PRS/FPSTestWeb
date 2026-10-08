#!/usr/bin/env python3
"""
Project Overview — size + line counts per area.
For each root (client/src, server_bun/src, shared) prints a per-filetype
table (files, KB, lines) plus a total. Every filetype found is listed —
nothing is filtered.
"""

import time
from pathlib import Path
from collections import defaultdict

start_time = time.time()

ROOTS = [
    ('client/src', Path('client/src')),
    ('server_bun/src', Path('server_bun/src')),
    ('shared', Path('shared')),
]

SKIP_DIRS = {
    'node_modules', '.git', 'build', 'bin', 'obj', '.vs', '.vscode',
}

# Extensions we can't meaningfully line-count (binary)
BINARY_EXTS = {
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
    '.glb', '.gltf', '.fbx', '.obj', '.bin', '.exr', '.hdr',
    '.wav', '.mp3', '.ogg', '.mp4', '.webm',
    '.zip', '.gz', '.7z', '.ttf', '.woff', '.woff2',
    '.exe', '.dll', '.wasm',
}


def get_line_count(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            return sum(1 for _ in f)
    except (IOError, OSError):
        return 0


def scan(root: Path):
    """ext -> [files, bytes, lines]"""
    stats = defaultdict(lambda: [0, 0, 0])
    for fp in root.rglob('*'):
        if not fp.is_file():
            continue
        if SKIP_DIRS & set(fp.parts):
            continue
        ext = fp.suffix.lower() or '(none)'
        s = stats[ext]
        s[0] += 1
        s[1] += fp.stat().st_size
        s[2] += 0 if ext in BINARY_EXTS else get_line_count(fp)
    return stats


def fmt_kb(b):
    return f'{b / 1024:.1f}' if b < 1024 * 1024 else f'{b / (1024 * 1024):.1f}M'


def report(name, stats):
    print(f'== {name} ==')
    ew = max(4, max(len(e) for e in stats) + 1)
    print(f'  {"ext":<{ew}} {"files":>6} {"KB":>10} {"lines":>8}')
    tf = tb = tl = 0
    # sort by size desc
    for ext, (n, size, lines) in sorted(stats.items(), key=lambda kv: -kv[1][1]):
        print(f'  {ext:<{ew}} {n:>6} {fmt_kb(size):>10} {lines:>8}')
        tf += n; tb += size; tl += lines
    print(f'  {"TOTAL":<{ew}} {tf:>6} {fmt_kb(tb):>10} {tl:>8}')
    print()
    return tf, tb, tl


def main():
    gf = gb = gl = 0
    for name, root in ROOTS:
        if not root.exists():
            print(f'== {name} == (missing)')
            continue
        f, b, l = report(name, scan(root))
        gf += f; gb += b; gl += l
    print('== ALL ==')
    print(f'  {"TOTAL":<8} {gf:>6} {fmt_kb(gb):>10} {gl:>8}')
    print(f'\nDuration: {time.time() - start_time:.2f}s')


if __name__ == '__main__':
    main()
