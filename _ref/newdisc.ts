// Weapon 1 — disc launcher (T1/T2/Ascend spinfusor DNA, not a copy): a
// Quake-RL hex tube with a horizontal slit cut clean through its front
// half. The flat chambered disc rides in the slit, cyan rim glowing
// through the gap — the slit IS the "fires discs" read.
const DISC_HEX_R = 0.13;
const DISC_SLIT_HALF = 0.02;

// Sutherland-Hodgman against one horizontal line: keeps the hexagon's
// part above (side=1) or below (side=-1) the slit edge. This is the
// "negative volume" — the slit is removed from the cross-section before
// extrusion, so its walls are real faceted geometry.
function hexHalf(side: 1 | -1): THREE.Shape {
  const hex: THREE.Vector2[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3; // vertices at 0/180deg → pointy flanks, flat top/bottom
    hex.push(new THREE.Vector2(Math.cos(a) * DISC_HEX_R, Math.sin(a) * DISC_HEX_R));
  }
  const inside = (p: THREE.Vector2) => side * p.y >= DISC_SLIT_HALF;
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < hex.length; i++) {
    const cur = hex[i]!;
    const nxt = hex[(i + 1) % hex.length]!;
    if (inside(cur)) out.push(cur);
    if (inside(cur) !== inside(nxt)) {
      const t = (side * DISC_SLIT_HALF - cur.y) / (nxt.y - cur.y);
      out.push(new THREE.Vector2(cur.x + (nxt.x - cur.x) * t, side * DISC_SLIT_HALF));
    }
  }
  return new THREE.Shape(out);
}

function extrudeAt(shape: THREE.Shape, zFront: number, depth: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }), mat);
  m.position.z = zFront;
  return m;
}

export function mkDisc(): THREE.Group {
const disc = new THREE.Group();
const zFront = -0.3;
const slitLen = 0.34;
disc.add(extrudeAt(hexHalf(1), zFront, slitLen, bodyMat));
disc.add(extrudeAt(hexHalf(-1), zFront, slitLen, bodyMat));
// Solid hex breech behind the slit — same profile, no cut
const fullHex = new THREE.Shape();
for (let k = 0; k <= 6; k++) {
  const a = (k * Math.PI) / 3;
  const x = Math.cos(a) * DISC_HEX_R, y = Math.sin(a) * DISC_HEX_R;
  if (k === 0) fullHex.moveTo(x, y); else fullHex.lineTo(x, y);
}
disc.add(extrudeAt(fullHex, zFront + slitLen, 0.18, bodyMat));
// Dark collar ring where the slit ends — the visual stop of the throat
disc.add(extrudeAt(fullHex, zFront + slitLen - 0.012, 0.024, darkMat)).scale.set(1.04, 1.04, 1);
// Chambered disc lying flat in the slit, rim just short of the flank
// tips, emissive rim so it reads through the gap from any side
const loadedMat = new THREE.MeshLambertMaterial({ color: 0x3a3f45, emissive: 0x14161a });
const loaded = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.022, 24), loadedMat);
loaded.position.set(0, 0, -0.15);
disc.add(loaded);
const rim = new THREE.Mesh(new THREE.TorusGeometry(0.112, 0.008, 6, 32),
  new THREE.MeshBasicMaterial({ color: 0x66e0ff }));
rim.rotation.x = Math.PI / 2;
rim.position.set(0, 0, -0.15);
disc.add(rim);
// Forend under the slit section + raked grip under the breech
const forend = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.24), darkMat);
forend.position.set(0, -0.135, -0.13);
disc.add(forend);
const discGrip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.06), darkMat);
discGrip.position.set(0, -0.17, 0.16);
discGrip.rotation.x = 0.35;
disc.add(discGrip);
const guard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.1), darkMat);
guard.position.set(0, -0.14, 0.09);
disc.add(guard);
disc.visible = false;
return disc;
}

