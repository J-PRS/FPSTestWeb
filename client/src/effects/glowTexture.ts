import * as THREE from 'three';

// Shared radial-gradient sprite textures — generated once, reused by every
// billboarded glow particle (trails, explosions, nuggets, impacts).
const cache = new Map<number, THREE.Texture>();

export function getGlowTexture(size = 64, falloff = 0.35, midA = 0.65): THREE.Texture {
  const key = size + falloff * 1000 + midA; // distinct curve = distinct cache entry
  let tex = cache.get(key);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(falloff, `rgba(255,255,255,${midA})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    tex = new THREE.CanvasTexture(c);
    cache.set(key, tex);
  }
  return tex;
}

// Smoke/debris puff: several offset soft blobs composited into one
// asymmetric blotch — a radially symmetric sprite makes billboard
// rotation invisible, which is why static quads read "low-poly 2005".
const puffCache = new Map<number, THREE.Texture>();

export function getPuffTexture(size = 128): THREE.Texture {
  let tex = puffCache.get(size);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const half = size / 2;
    // 7 overlapping blobs at fixed-but-ragged offsets — one draw call per
    // particle still, but the silhouette tumbles when the quad spins.
    const blobs: [number, number, number][] = [
      [0, 0, 0.42], [0.28, -0.12, 0.30], [-0.24, 0.16, 0.32],
      [0.08, 0.26, 0.26], [-0.10, -0.28, 0.24], [0.30, 0.18, 0.2], [-0.3, -0.06, 0.22],
    ];
    for (const [bx, by, br] of blobs) {
      const g = ctx.createRadialGradient(half + bx * half, half + by * half, 0,
        half + bx * half, half + by * half, br * size);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    tex = new THREE.CanvasTexture(c);
    puffCache.set(size, tex);
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
