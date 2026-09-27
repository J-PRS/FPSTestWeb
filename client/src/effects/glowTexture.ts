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

// Muzzle-flash sprite: hot radial core + a star of tapered spikes. Flat
// quads need an alpha-shaped texture or they read as literal squares —
// this gives the burst an irregular, spiky silhouette.
const flashCache = new Map<number, THREE.Texture>();

export function getMuzzleFlashTexture(size = 128): THREE.Texture {
  let tex = flashCache.get(size);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const half = size / 2;
    ctx.translate(half, half);
    // Spikes — tapered blades at uneven angles/lengths (roll on the mesh
    // re-randomizes the silhouette each shot anyway)
    const spikes = 6;
    for (let i = 0; i < spikes; i++) {
      const ang = (i / spikes) * Math.PI * 2 + 0.4 * Math.sin(i * 3.7);
      const len = half * (0.55 + 0.4 * ((i * 37 % 10) / 10));
      const w = half * 0.12;
      ctx.save();
      ctx.rotate(ang);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -w);
      ctx.quadraticCurveTo(len * 0.6, -w * 0.25, len, 0);
      ctx.quadraticCurveTo(len * 0.6, w * 0.25, 0, w);
      ctx.fill();
      ctx.restore();
    }
    // Core glow on top — hot center that sells the burn
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, half * 0.55);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(-half, -half, size, size);
    tex = new THREE.CanvasTexture(c);
    flashCache.set(size, tex);
  }
  return tex;
}
