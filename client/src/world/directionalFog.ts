import * as THREE from 'three';

// Sun-aware haze: three.js fog has a single flat color, so distant terrain
// reads the same whether you look at the sun or away from it. Per-fragment
// direction would need every material's fog chunk patched, so we tint the
// whole fog color by how far the camera is facing the sun — cheap Mie
// forward-scatter stand-in. Sunward pushes warm/bright, away cools slightly.
// The sky's horizon band gets the same tint so fully-fogged ground keeps
// dissolving into it.

// Float color ctor is linear-working-space (no sRGB conversion), so these
// read darker/more saturated than the numbers suggest.
const _sunTint = new THREE.Color(1.0, 0.82, 0.55);
const _awayTint = new THREE.Color(0.30, 0.55, 0.92);
const _camDir = new THREE.Vector3();

const SUNWARD_STRENGTH = 0.42;
const AWAY_STRENGTH = 0.18;

export function fogTint(base: THREE.Color, camDir: THREE.Vector3, sunDir: THREE.Vector3, out: THREE.Color): THREE.Color {
  // Only horizontal facing matters — looking straight up at the sun
  // shouldn't turn the ground haze white.
  const fwd = Math.hypot(camDir.x, camDir.z);
  if (fwd < 1e-6) return out.copy(base);
  const d = (camDir.x * sunDir.x + camDir.z * sunDir.z) / fwd;
  out.copy(base).lerp(_sunTint, Math.pow(Math.max(0, d), 2.0) * SUNWARD_STRENGTH);
  out.lerp(_awayTint, Math.pow(Math.max(0, -d), 2.0) * AWAY_STRENGTH);
  return out;
}

// Base color is captured lazily — scene.fog.color is the thing we mutate,
// so it can't be read back as the source on later frames.
let _base: THREE.Color | null = null;
const _tinted = new THREE.Color();

/** Map-spec fog replaces the ambient haze — re-seed the base the sun
 *  tints from, since fog.color itself is overwritten each frame. */
export function setFogBase(color: THREE.Color): void {
  _base = color.clone();
}

export function updateDirectionalFog(fog: THREE.Fog, camera: THREE.Camera, sunDir: THREE.Vector3): THREE.Color {
  if (!_base) _base = fog.color.clone();
  camera.getWorldDirection(_camDir);
  return fogTint(_base, _camDir, sunDir, _tinted);
}
