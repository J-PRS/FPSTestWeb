import os
from PIL import Image

SRC_ROOT = os.path.join(os.path.dirname(__file__), '..', 'screenshots')
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
# Class tabs come first — the loadout read is the point of this gallery.
# (tab id, src subdir, web subdir)
TABS = [
    ('light',  'poses-light',  'poses-light'),
    ('medium', 'poses-medium', 'poses-medium'),
    ('heavy',  'poses-heavy',  'poses-heavy'),
]
# Legacy reference sets stay below the tabs, collapsed.
LEGACY = [
    ('poses-ual2', 'poses-ual2', 'UAL2 — ski, jet, slide'),
    ('poses-man', 'poses-man', 'Mannequin (UAL)'),
]

def convert_dir(src_rel, out_rel):
    src = os.path.join(SRC_ROOT, src_rel)
    if not os.path.isdir(src):
        return []
    out_sub = os.path.join(OUT_DIR, out_rel)
    os.makedirs(out_sub, exist_ok=True)
    imgs = []
    for f in sorted(os.listdir(src)):
        if not f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            continue
        name = os.path.splitext(f)[0]
        dst = os.path.join(out_sub, name + '.webp')
        src_img = os.path.join(src, f)
        if f.lower().endswith('.webp'):
            if not os.path.exists(dst):
                Image.open(src_img).save(dst, 'WEBP', quality=82, method=6)
        else:
            im = Image.open(src_img)
            if max(im.size) > 1200:
                im.thumbnail((1200, 1200), Image.LANCZOS)
            im.save(dst, 'WEBP', quality=82, method=6)
        imgs.append(f'<a class="card" data-full="{out_rel}/{name}.webp">'
                    f'<img src="{out_rel}/{name}.webp" loading="lazy" alt="{name}">'
                    f'<span>{name}</span></a>')
    return imgs

tab_buttons = []
tab_panels = []
for i, (tab_id, src_rel, out_rel) in enumerate(TABS):
    imgs = convert_dir(src_rel, out_rel)
    if not imgs:
        continue
    tab_buttons.append(f'<button class="tab{" on" if i==0 else ""}" data-t="{tab_id}">{tab_id.upper()}</button>')
    tab_panels.append(f'<div class="tpanel" id="t-{tab_id}"{" " if i==0 else " hidden"}><div class="grid">{"".join(imgs)}</div></div>')

sections = []
for src_rel, out_rel, title in LEGACY:
    imgs = convert_dir(src_rel, out_rel)
    if imgs:
        sections.append(f'<details class="old"><summary>{title} ({len(imgs)})</summary><div class="grid">{"".join(imgs)}</div></details>')

html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>KRIBES pose gallery</title><meta name="viewport" content="width=device-width">
<style>
body{{background:#0b0e14;color:#dfe6f0;font:14px/1.4 system-ui,sans-serif;margin:0;padding:16px}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;color:#8fd0ff;margin:20px 0 8px;text-transform:uppercase;letter-spacing:.08em}}
.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}}
.card{{display:block;background:#141a26;border:1px solid #232c3d;border-radius:8px;overflow:hidden;cursor:pointer}}
.card img{{width:100%;display:block;aspect-ratio:1;object-fit:cover;background:#fff}}
.card span{{display:block;padding:5px 7px;font-size:10px;font-family:ui-monospace,monospace;color:#cfe0f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.tabs{{display:flex;gap:8px;margin:14px 0 12px}}
.tab{{flex:1;background:#141a26;border:1px solid #232c3d;border-radius:8px;color:#8fa4c0;font:600 12px/1 system-ui;padding:10px;cursor:pointer;letter-spacing:.1em}}
.tab.on{{background:#1d2c44;color:#cfe6ff;border-color:#3f63a0}}
details.old{{margin-top:20px}} details.old summary{{color:#7a8aa0;font-size:13px;cursor:pointer;padding:6px 0}}
#lb{{position:fixed;inset:0;background:rgba(5,8,12,.95);display:none;align-items:center;justify-content:center;z-index:9;touch-action:none}}
#lb.on{{display:flex}} #lb img{{max-width:96vw;max-height:88vh;object-fit:contain;background:#fff;border-radius:6px}}
#lb .cap{{position:absolute;bottom:12px;left:0;right:0;text-align:center;color:#9db4d0;font-size:12px;font-family:ui-monospace,monospace}}
#lb .x{{position:absolute;top:14px;right:18px;font-size:28px;color:#fff;cursor:pointer;line-height:1}}
#lb .nav{{position:absolute;top:50%;transform:translateY(-50%);font-size:36px;color:#fff9;cursor:pointer;padding:16px;user-select:none}}
#lb .nav:hover{{color:#fff}} #lb .l{{left:4px}} #lb .r{{right:4px}}
@media (max-width:520px){{#lb .nav{{display:none}}}}
</style></head><body>
<h1>KRIBES pose gallery</h1>
<p style="color:#7a8aa0;margin-top:0">Tap a pose to zoom — swipe or arrows to move.</p>
<div class="tabs">{''.join(tab_buttons)}</div>
{''.join(tab_panels)}
{''.join(sections)}
<div id="lb"><span class="x">&times;</span><span class="nav l">&#8249;</span><img alt=""><span class="nav r">&#8250;</span><div class="cap"></div></div>
<script>
let cards=[];
const lb=document.getElementById('lb'),im=lb.querySelector('img'),cap=lb.querySelector('.cap');
let i=0;
function show(n){{i=(n+cards.length)%cards.length;const c=cards[i];im.src=c.dataset.full;cap.textContent=c.querySelector('span').textContent;}}
// Tab switch rescopes the card list — swipe/arrows stay inside the class.
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{{
 document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x===b));
 document.querySelectorAll('.tpanel').forEach(p=>p.hidden=p.id!=='t-'+b.dataset.t);
 bindCards();}}));
function bindCards(){{
 cards=[...document.querySelectorAll('.tpanel:not([hidden]) .card, details.old .card')];
 cards.forEach((c,n)=>{{c.onclick=()=>{{show(n);lb.classList.add('on');}};}});
}}
bindCards();
lb.querySelector('.x').onclick=()=>lb.classList.remove('on');
lb.querySelector('.l').onclick=e=>{{e.stopPropagation();show(i-1);}};
lb.querySelector('.r').onclick=e=>{{e.stopPropagation();show(i+1);}};
im.onclick=()=>lb.classList.remove('on');
lb.onclick=()=>lb.classList.remove('on');
addEventListener('keydown',e=>{{if(!lb.classList.contains('on'))return;
 if(e.key==='Escape')lb.classList.remove('on');
 if(e.key==='ArrowLeft')show(i-1); if(e.key==='ArrowRight')show(i+1);}});
let sx=0;
lb.addEventListener('touchstart',e=>sx=e.touches[0].clientX,{{passive:true}});
lb.addEventListener('touchend',e=>{{const d=e.changedTouches[0].clientX-sx;
 if(Math.abs(d)>40)show(d<0?i+1:i-1);}},{{passive:true}});
</script>
</body></html>"""

with open(os.path.join(OUT_DIR, 'index.html'), 'w') as f:
    f.write(html)
print('wrote index.html')
