"""Regenerate icon_star.png from `icon_hex copy.png` (the original teal hex icon).

Pipeline: hue-shift the teal ring to blue (keeps its gradient + long shadow),
flatten the inner disc, stamp a fat rotated-plus X, overlay a sharp 4-point
heraldic star.

    python icon.py            # writes icon_hex.png
    python icon.py out.png    # custom output path
"""
import colorsys
import math
import sys
from PIL import Image, ImageDraw

HERE = __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0]
SRC = HERE + "/icon_hex copy.png"
OUT = sys.argv[1] if len(sys.argv) > 1 else HERE + "/icon_star.png"

DISC = (26, 26, 26)          # inner disc, sampled from the original
DISC_R = 196                 # inner disc radius (px @512)
GLYPH = (196, 226, 232)      # pale glyph color
BLUE_HUE = 208 / 360         # target ring hue
TEAL_HUE = 170 / 360         # original ring hue
X_LEN, X_T = 290, 58         # rotated-plus bars: length, thickness
STAR_OUT, STAR_IN = 170, 40  # heraldic star: tip radius, waist radius


def main():
    img = Image.open(SRC).convert("RGBA")
    px = img.load()
    S = img.width
    cx = cy = S / 2

    for y in range(S):
        for x in range(S):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            dx, dy = x - cx, y - cy
            if dx * dx + dy * dy < DISC_R * DISC_R:
                px[x, y] = DISC + (255,)  # erase old glyph: disc is flat
                continue
            h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if 140 < h * 360 < 200 and s > 0.3:  # teal ring -> blue, keep luma
                nh = BLUE_HUE + (h - TEAL_HUE) * 0.9
                nr, ng, nb = colorsys.hls_to_rgb(nh % 1, l, s)
                px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)

    # fat rounded X (rotated +)
    for ang in (45, 135):
        bar = Image.new("RGBA", (X_LEN, X_T), (0, 0, 0, 0))
        ImageDraw.Draw(bar).rounded_rectangle(
            [0, 0, X_LEN, X_T], radius=X_T // 5, fill=GLYPH + (255,))
        rot = bar.rotate(ang, expand=True, resample=Image.BICUBIC)
        img.alpha_composite(rot, (int(cx - rot.width / 2), int(cy - rot.height / 2)))

    # sharp 4-sided heraldic star overlay
    star = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    pts = [(cx + (STAR_OUT if i % 2 == 0 else STAR_IN) * math.sin(math.radians(45 * i)),
            cy - (STAR_OUT if i % 2 == 0 else STAR_IN) * math.cos(math.radians(45 * i)))
           for i in range(8)]
    ImageDraw.Draw(star).polygon(pts, fill=GLYPH + (255,))
    img.alpha_composite(star)

    img.save(OUT)
    print(OUT)


if __name__ == "__main__":
    main()
