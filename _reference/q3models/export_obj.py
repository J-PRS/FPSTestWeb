"""Export a composed Q3 player model (lower+upper+head stitched via tags) to OBJ."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pk3_archive import PK3Archive
from md3_player_model import MD3PlayerModel, _transform_point, _matrix_multiply_3x3
from md3_types import TagTransform


def export(pk3_path, model_path, skin, out_dir, legs_frame=None, torso_frame=None):
    arch = PK3Archive(pk3_path)
    m = MD3PlayerModel(arch, model_path)
    if skin != 'default':
        m.select_skin(skin)
    name = m.model_name

    # pick static frames: LEGS_IDLE / TORSO_STAND first frames
    anims = m.anim_config.animations
    from md3_types import AnimNumber
    lf = legs_frame if legs_frame is not None else anims[AnimNumber.LEGS_IDLE].firstFrame
    tf = torso_frame if torso_frame is not None else anims[AnimNumber.TORSO_STAND].firstFrame

    legs_t = TagTransform()  # identity
    torso_tag = m._lower.tag_for_name('tag_torso', lf)
    torso_t = m._position_child_on_tag(legs_t, torso_tag)
    head_tag = m._upper.tag_for_name('tag_head', tf)
    head_t = m._position_child_on_tag(torso_t, head_tag)

    parts = [
        (m._lower, lf, legs_t, m._lower_skin),
        (m._upper, tf, torso_t, m._upper_skin),
        (m._head, 0, head_t, m._head_skin),
    ]

    obj_path = os.path.join(out_dir, f'{name}_{skin}.obj')
    mtl_path = os.path.join(out_dir, f'{name}_{skin}.mtl')
    v_off = 1
    mats = {}
    obj_lines = [f'mtllib {os.path.basename(mtl_path)}']

    for model, frame, t, skind in parts:
        for surf in model.surfaces:
            tex = skind.get(surf.name) or skind.get(surf.name.lower()) or ''
            tex_base = os.path.basename(tex).replace('.tga', '.png') if tex else 'none'
            mat = f'{name}_{tex_base}'
            mats[mat] = tex
            obj_lines.append(f'o {surf.name}')
            obj_lines.append(f'usemtl {mat}')
            base = frame * surf.numVerts
            for i in range(surf.numVerts):
                p = _transform_point(surf.vertices[base + i].position, t.origin, t.axis)
                # Q3 Z-up -> OBJ Y-up: (x, z, -y)
                obj_lines.append(f'v {p[0]:.4f} {p[2]:.4f} {-p[1]:.4f}')
            tc = surf.texCoords
            for i in range(surf.numVerts):
                obj_lines.append(f'vt {tc[2*i]:.4f} {tc[2*i+1]:.4f}')
            tris = surf.triangles
            for i in range(0, len(tris), 3):
                a, b, c = tris[i] + v_off, tris[i+1] + v_off, tris[i+2] + v_off
                obj_lines.append(f'f {a}/{a} {b}/{b} {c}/{c}')
            v_off += surf.numVerts

    with open(obj_path, 'w') as f:
        f.write('\n'.join(obj_lines))

    mtl_lines = []
    for mat, tex in mats.items():
        mtl_lines.append(f'newmtl {mat}')
        mtl_lines.append('Kd 0.8 0.8 0.8')
        if tex:
            png = os.path.basename(tex).replace('.tga', '.png')
            src = f'models/players/{name}/{os.path.basename(tex)}'
            data = arch.read_file(src)
            if data:
                tga_path = os.path.join(out_dir, os.path.basename(tex))
                with open(tga_path, 'wb') as tf:
                    tf.write(data)
                mtl_lines.append(f'map_Kd {os.path.basename(tex)}')
        mtl_lines.append('')
    with open(mtl_path, 'w') as f:
        f.write('\n'.join(mtl_lines))
    print(f'wrote {obj_path}')


if __name__ == '__main__':
    pk3 = r'D:\[ARCHIVE]\2024.01.29\DeFRaG\baseq3\pak0.pk3'
    out = r'C:\TEMP\_WEB\FPSWebTest\_reference\q3models\obj'
    os.makedirs(out, exist_ok=True)
    for model, skin in [('keel', 'blue'), ('visor', 'blue'), ('keel', 'red'), ('visor', 'red'), ('tankjr', 'default')]:
        export(pk3, f'models/players/{model}', skin, out)
