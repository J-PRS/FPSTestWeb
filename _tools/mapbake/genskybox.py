# Generate a simple procedural skybox for the glacier map
from PIL import Image

SIZE = 512
OUT = 'maps/glacier'

import os
os.makedirs(OUT, exist_ok=True)

side_top = (100, 130, 170)
side_bot = (180, 190, 210)
top = (80, 110, 160)
bot = (190, 200, 215)

# py (top) - deep blue
img = Image.new('RGB', (SIZE, SIZE))
px = img.load()
for y in range(SIZE):
    for x in range(SIZE):
        t = y / (SIZE - 1)
        r = int(top[0] * (1-t) + (160) * t)
        g = int(top[1] * (1-t) + (180) * t)
        b = int(top[2] * (1-t) + (210) * t)
        px[x, y] = (r, g, b)
img.save(f'{OUT}/py.png')

# ny (bottom) - pale white/ice
img = Image.new('RGB', (SIZE, SIZE))
px = img.load()
for y in range(SIZE):
    for x in range(SIZE):
        px[x, y] = (220, 225, 235)
img.save(f'{OUT}/ny.png')

# px, nx, pz, nz (sides) - gradient from sky blue to white
for face in ['px', 'nx', 'pz', 'nz']:
    img = Image.new('RGB', (SIZE, SIZE))
    px = img.load()
    for y in range(SIZE):
        for x in range(SIZE):
            t = y / (SIZE - 1)
            r = int(side_top[0] * (1-t) + side_bot[0] * t)
            g = int(side_top[1] * (1-t) + side_bot[1] * t)
            b = int(side_top[2] * (1-t) + side_bot[2] * t)
            px[x, y] = (r, g, b)
    img.save(f'{OUT}/{face}.png')

print('skybox generated:', os.listdir(OUT))
