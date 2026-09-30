import * as THREE from 'three';

// Fake god rays — one additive quad at the sun's position with a procedural
// radial-streak texture. Real shafts need a depth-aware radial post pass;
// this gets 90% of the read for one draw call and zero per-frame CPU. The
// sprite is placed far out on the sun direction, so terrain/mountains
// occlude it naturally (depthTest stays on) — that's what sells the rays
// as coming *through* the world rather than pasted on screen.
//
// Opacity fades to zero when the camera isn't looking sunward — visible
// shafts staring at the ground would read as a UI artifact.

const TEX_SIZE = 256;
const SPRITE_SIZE = 2200; // meters across — spans a big chunk of sky
const MAX_OPACITY = 0.35;

function makeShaftTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;
  const cx = TEX_SIZE / 2;

  // Bright core
  const core = ctx.createRadialGradient(cx, cx, 0, cx, cx, TEX_SIZE * 0.5);
  core.addColorStop(0, 'rgba(255,250,230,0.9)');
  core.addColorStop(0.25, 'rgba(255,245,215,0.35)');
  core.addColorStop(1, 'rgba(255,245,215,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  // Radial streaks — alpha varies per spoke so it reads as rays, not a glow
  ctx.globalCompositeOperation = 'lighter';
  const spokes = 24;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + Math.random() * 0.15;
    const len = TEX_SIZE * (0.3 + Math.random() * 0.2);
    const w = 0.012 + Math.random() * 0.02; // radians of width
    const alpha = 0.05 + Math.random() * 0.1;
    ctx.beginPath();
    ctx.moveTo(cx, cx);
    ctx.arc(cx, cx, len, a - w, a + w);
    ctx.closePath();
    const g = ctx.createRadialGradient(cx, cx, TEX_SIZE * 0.05, cx, cx, len);
    g.addColorStop(0, `rgba(255,245,215,${alpha})`);
    g.addColorStop(1, 'rgba(255,245,215,0)');
    ctx.fillStyle = g;
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class SunShafts {
  private sprite: THREE.Sprite;
  private material: THREE.SpriteMaterial;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private camDir = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.material = new THREE.SpriteMaterial({
      map: makeShaftTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
      opacity: 0,
      fog: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.setScalar(SPRITE_SIZE);
    this.sprite.renderOrder = -1; // with the sky, behind all gameplay alpha
    scene.add(this.sprite);
  }

  update(camera: THREE.Camera, sunPosition: THREE.Vector3): void {
    // Anchor on the sun direction at sky distance — parallax-free.
    this.sunDir.copy(sunPosition).normalize();
    this.sprite.position.copy(this.sunDir).multiplyScalar(3600).add(camera.position);

    camera.getWorldDirection(this.camDir);
    const facing = Math.max(0, this.camDir.dot(this.sunDir));
    // Squared falloff: shafts bloom only when genuinely looking sunward.
    this.material.opacity = facing * facing * MAX_OPACITY;
  }
}
