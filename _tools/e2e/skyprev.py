# Offline preview of the cube-dome sky + fog band — same math as the
# dome shader (dir -> cube face sample -> smoothstep band -> fog mix).
import math
import numpy as np
from PIL import Image

SKY = "maps/t2/trident/sky"
FOG = np.array([0.20, 0.525, 0.625])  # trident mission fogColor
W, H = 800, 450
YAW_DEG = -30.0   # aim toward the px sunburst to check the seam zone
FOV = 75.0

faces = {k: np.asarray(Image.open(f"{SKY}/{k}.png").convert("RGB"), np.float32) / 255.0 for k in
         ("px", "nx", "py", "ny", "pz", "nz")}


def sample_cube(d):
    ax, ay, az = np.abs(d[..., 0]), np.abs(d[..., 1]), np.abs(d[..., 2])
    m = np.maximum(ax, np.maximum(ay, az))
    # choose face + compute u,v in face space (GL cubemap convention)
    face = np.full(d.shape[:-1], -1, np.int8)
    u = np.zeros(d.shape[:-1], np.float32)
    v = np.zeros_like(u)
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    sel = (ax == m) & (x > 0); face[sel] = 0; u[sel] = -z[sel]; v[sel] = -y[sel]
    sel = (ax == m) & (x <= 0); face[sel] = 1; u[sel] = z[sel]; v[sel] = -y[sel]
    sel = (ay == m) & (y > 0); face[sel] = 2; u[sel] = x[sel]; v[sel] = z[sel]
    sel = (ay == m) & (y <= 0); face[sel] = 3; u[sel] = x[sel]; v[sel] = -z[sel]
    sel = (az == m) & (z > 0); face[sel] = 4; u[sel] = x[sel]; v[sel] = -y[sel]
    sel = (az == m) & (z <= 0); face[sel] = 5; u[sel] = -x[sel]; v[sel] = -y[sel]
    u = (u / m + 1.0) * 0.5
    v = (v / m + 1.0) * 0.5
    out = np.zeros(d.shape, np.float32)
    order = ("px", "nx", "py", "ny", "pz", "nz")
    for i, name in enumerate(order):
        sel = face == i
        if not sel.any():
            continue
        img = faces[name]
        ih, iw = img.shape[:2]
        px_ = np.clip(u[sel] * (iw - 1), 0, iw - 1).astype(np.int32)
        py_ = np.clip(v[sel] * (ih - 1), 0, ih - 1).astype(np.int32)
        out[sel] = img[py_, px_]
    return out


yaw = math.radians(YAW_DEG)
aspect = W / H
tf = math.tan(math.radians(FOV) / 2)
pxs = np.zeros((H, W, 3), np.float32)
cy = np.linspace(-1, 1, H, dtype=np.float32)
cx = np.linspace(-1, 1, W, dtype=np.float32)
gx, gy = np.meshgrid(cx, cy)
dir_cam = np.stack([gx * aspect * tf, gy * tf, np.ones_like(gx)], -1)  # +z fwd view
# camera looks along -z in three.js; rebuild dir: forward = (sin yaw, pitch 0, -cos yaw)... keep simple:
# treat dir_cam as (x right, y up, z forward), normalize, rotate by yaw around Y.
n = np.linalg.norm(dir_cam, axis=-1, keepdims=True)
d = dir_cam / n
cy_, sy_ = math.cos(yaw), math.sin(yaw)
dx = d[..., 0] * cy_ + d[..., 2] * sy_
dz = -d[..., 0] * sy_ + d[..., 2] * cy_
d = np.stack([dx, d[..., 1], dz], -1)
pxs = sample_cube(d)
# sRGB-ish output is already in display space (faces are display pngs); fog color is linear —
# apply band in display space approximation to match visual expectation roughly.
band = np.clip((0.09 - d[..., 1]) / (0.09 + 0.02), 0.0, 1.0)
band = band * band * (3 - 2 * band)
fog_disp = FOG ** (1 / 2.2)  # approx display value of the linear fog color
pxs = pxs * (1 - band[..., None]) + fog_disp[None, None, :] * band[..., None]
Image.fromarray((np.clip(pxs, 0, 1) * 255).astype(np.uint8)).save("_tools/e2e/shots/_skyprev.png")
print("wrote _tools/e2e/shots/_skyprev.png")
