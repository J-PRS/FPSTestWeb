import os
from PIL import Image

SRC_ROOT = os.path.join(os.path.dirname(__file__), '..', 'screenshots')
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
GALLERIES = {'poses': 'Poses — RobotExpressive', 'poses-man': 'Poses — Mannequin (UAL)'}

cards = []
for sub, title in GALLERIES.items():
    src = os.path.join(SRC_ROOT, sub)
    if not os.path.isdir(src):
        continue
    cards.append(f'<h2>{title}</h2><div class="grid">')
    out_sub = os.path.join(OUT_DIR, sub)
    os.makedirs(out_sub, exist_ok=True)
    for f in sorted(os.listdir(src)):
        if not f.lower().endswith(('.png', '.jpg', '.jpeg')):
            continue
        name = os.path.splitext(f)[0]
        dst = os.path.join(out_sub, name + '.webp')
        im = Image.open(os.path.join(src, f))
        if max(im.size) > 1200:
            im.thumbnail((1200, 1200), Image.LANCZOS)
        im.save(dst, 'WEBP', quality=82, method=6)
        cards.append(
            f'<a class="card" href="{sub}/{name}.webp" target="_blank">'
            f'<img src="{sub}/{name}.webp" loading="lazy" alt="{name}">'
            f'<span>{name}</span></a>')
    cards.append('</div>')

html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>KRIBES pose gallery</title><meta name="viewport" content="width=device-width">
<style>
body{{background:#0b0e14;color:#dfe6f0;font:14px/1.4 system-ui,sans-serif;margin:0;padding:24px}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;color:#8fd0ff;margin:22px 0 10px;text-transform:uppercase;letter-spacing:.08em}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}}
.card{{display:block;background:#141a26;border:1px solid #232c3d;border-radius:10px;overflow:hidden;text-decoration:none;color:#cfe0f5}}
.card img{{width:100%;display:block;aspect-ratio:1;object-fit:cover;background:#000}}
.card span{{display:block;padding:8px 10px;font-size:12px;font-family:ui-monospace,monospace}}
</style></head><body>
<h1>KRIBES pose gallery</h1>
<p style="color:#7a8aa0;margin-top:0">Auto-generated preview — webp, q82, max 1200px.</p>
{''.join(cards)}
</body></html>"""

with open(os.path.join(OUT_DIR, 'index.html'), 'w') as f:
    f.write(html)
print('wrote index.html')
