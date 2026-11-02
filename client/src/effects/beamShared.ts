// beamShared - constants and helpers shared by lightningBeam and beamBuild.
// Extracted to break the lightningBeam <-> beamBuild cycle (lightningBeam
// imported buildBeam from beamBuild; beamBuild imported SEGS/SPARKS and
// LightningBeam.makeGlowTexture from lightningBeam). Both now depend on
// this leaf module, one direction only.
import * as THREE from 'three';

export const SEGS = 16;
export const SPARKS = 26; // hitpoint fountain particles

let _glowTex: THREE.Texture | null = null;
export function makeGlowTexture(): THREE.Texture {
  if (_glowTex) {return _glowTex;}
  const c = document.createElement('canvas');
  c.height = 64;
  c.width = c.height;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(180,230,255,0.8)');
  g.addColorStop(1, 'rgba(60,140,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}
