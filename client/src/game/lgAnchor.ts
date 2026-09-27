import * as THREE from 'three';

const _r = new THREE.Vector3(); // camera basis vectors
const _u = new THREE.Vector3();
const _f = new THREE.Vector3();

// Emitter ball's rest position in view space — REST_POS 0.25/-0.28/-0.45
// plus the muzzle node's z (-0.42) through the group's 0.8 scale.
export const LG_MUZZLE_X = 0.25;
export const LG_MUZZLE_Y = -0.28;
export const LG_MUZZLE_Z = -0.79;

// Beam-start anchor: FIXED camera-space offset re-derived from the live
// matrix every call. The bolt can't lag what it can't depend on — no
// viewmodel matrices, no frame-stale transforms, welded to the screen by
// construction. Kept dependency-free so tests can import it directly.
export function lgMuzzleAnchor(cam: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
  // matrixWorld is computed LAZILY by the renderer — reading it mid-update
  // gives LAST frame's transform. That's the "beam lags one frame behind"
  // bug: cam.position is fresh but the basis columns are stale, and the
  // error scales with speed. updateMatrixWorld forces this-frame truth.
  // The camera has no parent chain to update and no children that matter,
  // so this is cheap and safe to call every frame.
  cam.updateMatrixWorld();
  _r.setFromMatrixColumn(cam.matrixWorld, 0);
  _u.setFromMatrixColumn(cam.matrixWorld, 1);
  _f.setFromMatrixColumn(cam.matrixWorld, 2);
  return out.copy(cam.position)
    .addScaledVector(_r, LG_MUZZLE_X)
    .addScaledVector(_u, LG_MUZZLE_Y)
    .addScaledVector(_f, LG_MUZZLE_Z);
}
