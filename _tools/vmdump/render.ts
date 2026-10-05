// Headless weapon render — NO browser, NO playwright. `bun render.ts w=0`
// builds the live procedural viewmodel, rasterizes it with a tiny
// z-buffered software renderer (flat lambert + per-face shade), writes a
// PNG. Silhouette/part-layout checks in milliseconds; AO/wear/shaders are
// intentionally absent (those need the real pipeline → poseshot).
import * as THREE from '../../client/node_modules/three/build/three.module.js';
import { PNG } from 'pngjs';
import { MODEL_BUILDERS } from '../../client/src/entities/viewmodel/weaponsGeo.ts';
import { ARCHIVE_BUILDERS } from '../../client/src/entities/viewmodel/weaponsGeoArchive.ts';
import { writeFileSync } from 'fs';

const arg = (k: string, d: string) => (process.argv.find(a => a.startsWith(k + '='))?.split('=')[1] ?? d);
const W = +arg('w', '0'), PW = +arg('px', '900'), PH = +arg('ph', '600');
const YAW = +arg('yaw', '0.7'), PITCH = +arg('pitch', '-0.15'), DIST = +arg('dist', '1.1');
const OUT = arg('out', `${import.meta.dir}/render_w${W}.png`);

const named = ARCHIVE_BUILDERS.find(([n]) => n === `w${W}` || n === arg('name', ''));
const builder = MODEL_BUILDERS.find(([wt]) => wt === W)?.[1] ?? named?.[1];
if (!builder) { console.error(`no builder for w${W}`); process.exit(1); }
const g = builder() as THREE.Group;
g.visible = true;
g.traverse(o => { o.visible = true; });
const root = new THREE.Group();
root.add(g);
const inner = g as any;
if (inner.g) { root.remove(inner); root.add(inner.g); inner.g.visible = true; inner.g.traverse((o: any) => o.visible = true); }
root.updateWorldMatrix(true, true);

// Camera on a turntable, pitched down at the gun.
const cam = new THREE.PerspectiveCamera(40, PW / PH, 0.01, 50);
cam.position.set(Math.sin(YAW) * DIST, -PITCH * DIST, Math.cos(YAW) * DIST);
cam.lookAt(0, 0.02, -0.1);
cam.updateMatrixWorld();
const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
const light = new THREE.Vector3(0.5, 0.8, 0.6).normalize();

const img = new PNG({ width: PW, height: PH });
const zbuf = new Float32Array(PW * PH).fill(Infinity);
for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 24; img.data[i + 1] = 26; img.data[i + 2] = 30; img.data[i + 3] = 255; }

const v = new THREE.Vector3(), nrm = new THREE.Vector3();
const camFwd = new THREE.Vector3();
cam.getWorldDirection(camFwd);
const camPos = cam.position.clone();
root.traverse(o => {
  const m = o as THREE.Mesh;
  if (!(m as any).isMesh || !m.geometry) return;
  const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshLambertMaterial;
  const base = (mat as any).color?.clone() ?? new THREE.Color(0x888888);
  const pos = m.geometry.getAttribute('position');
  if (!pos) return;
  const nm = m.geometry.getAttribute('normal');
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const pts: [number, number, number][] = [];
    let behind = false;
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(pos as any, i + k).applyMatrix4(m.matrixWorld);
      if (v.clone().sub(camPos).dot(camFwd) <= 0.01) { behind = true; break; }
      v.applyMatrix4(vp); // already NDC — applyMatrix4 does the w divide
      pts.push([(v.x * 0.5 + 0.5) * PW, (0.5 - v.y * 0.5) * PH, v.z]);
    }
    if (behind) continue;
    // face normal in world space for lambert
    if (nm) nrm.fromBufferAttribute(nm as any, i).transformDirection(m.matrixWorld).normalize();
    else nrm.set(0, 0, 1);
    const shade = Math.max(0.3, nrm.dot(light) * 0.55 + 0.45);
    const r = Math.min(255, base.r * 255 * shade + 60 * shade), gg = Math.min(255, base.g * 255 * shade + 60 * shade), b = Math.min(255, base.b * 255 * shade + 60 * shade);
    const [p0, p1, p2] = pts;
    const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0]))), maxX = Math.min(PW - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1]))), maxY = Math.min(PH - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
    const d = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(d) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const w0 = ((p1[0] - x) * (p2[1] - y) - (p2[0] - x) * (p1[1] - y)) / d;
      const w1 = ((p2[0] - x) * (p0[1] - y) - (p0[0] - x) * (p2[1] - y)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * p0[2] + w1 * p1[2] + w2 * p2[2];
      const idx = y * PW + x;
      if (z < zbuf[idx]) { zbuf[idx] = z; const o4 = idx * 4; img.data[o4] = r; img.data[o4 + 1] = gg; img.data[o4 + 2] = b; }
    }
  }
});
writeFileSync(OUT, PNG.sync.write(img));
console.log(`${OUT} (${W})`);
