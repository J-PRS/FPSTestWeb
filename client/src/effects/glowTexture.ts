import * as THREE from 'three';

// Shared radial-gradient sprite textures — generated once, reused by every
// billboarded glow particle (trails, explosions, nuggets, impacts).
const cache = new Map<number, THREE.Texture>();

export function getGlowTexture(size = 64): THREE.Texture {
  let tex = cache.get(size);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    tex = new THREE.CanvasTexture(c);
    cache.set(size, tex);
  }
  return tex;
}
