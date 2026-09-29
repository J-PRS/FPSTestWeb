/**
 * ballTrails — the sparkle layer behind a bouncing ball. Two-layer sprite
 * dot (tinted halo + near-white core) scattered inside a small sphere
 * around the ball, random size and lifetime, pooled so emit/fade never
 * create or dispose materials mid-match.
 */
import * as THREE from 'three';

const TRAIL_COUNT = 14;
const TRAIL_INTERVAL = 0.04;

interface TrailDot {
  halo: THREE.Sprite;
  core: THREE.Sprite;
  age: number;
  life: number;    // per-dot random lifetime
  haloSz: number;  // per-dot random base scales
  coreSz: number;
}

const _spawn = new THREE.Vector3();
const _scatter = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1);

// Shared radial-gradient sprite texture: hot center -> colored mid -> soft
// transparent rim. Per-dot sprites tint it; additive blending accumulates
// overlapping dots into the "bright core / soft halo" layered trail look.
let _trailTex: THREE.Texture | null = null;
export function getTrailTex(): THREE.Texture {
  if (!_trailTex) {
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
    g.addColorStop(0,    'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.18)');
    g.addColorStop(1,    'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    _trailTex = new THREE.CanvasTexture(c);
  }
  return _trailTex;
}

export class BallTrailDots {
  private dots: TrailDot[] = [];
  private pool: TrailDot[] = [];
  private timer = 0;

  constructor(private scene: THREE.Scene) {}

  /** Emit a sparkle when the cadence fires — caller passes the ball's
   *  render pos, radius, and tint (enraged tint swaps handled upstream). */
  emit(dt: number, pos: THREE.Vector3, vel: THREE.Vector3, radius: number, tint: THREE.Color): void {
    this.timer += dt;
    if (this.timer < TRAIL_INTERVAL) return;
    this.timer = 0;
    if (vel.lengthSq() <= 0.5) return;
    this.spawn(pos, radius, tint);
  }

  /** Dust-burst at takeoff/land — count dots now, timer not involved. */
  burst(count: number, pos: THREE.Vector3, radius: number, tint: THREE.Color): void {
    for (let i = 0; i < count; i++) this.spawn(pos, radius, tint);
  }

  get size(): number { return this.dots.length; }

  private spawn(pos: THREE.Vector3, radius: number, tint: THREE.Color): void {
    const spawn = _spawn.copy(pos).addScaledVector(_scatter.set(
      Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1,
    ).normalize().multiplyScalar(Math.random() * radius * 0.6), 1);
    const haloSz = radius * (1.8 + Math.random() * 2.0);
    const coreSz = radius * (0.9 + Math.random() * 1.0);
    const life = 0.35 + Math.random() * 0.85;
    let d = this.pool.pop();
    if (d) {
      d.halo.position.copy(spawn);
      d.core.position.copy(spawn);
      this.scene.add(d.halo); this.scene.add(d.core);
    } else {
      const tex = getTrailTex();
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: tint, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: tint.clone().lerp(_white, 0.65),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.position.copy(spawn); core.position.copy(spawn);
      this.scene.add(halo); this.scene.add(core);
      d = { halo, core, age: 0, life, haloSz, coreSz };
    }
    (d.halo.material as THREE.SpriteMaterial).color.copy(tint);
    (d.core.material as THREE.SpriteMaterial).color.copy(tint).lerp(_white, 0.65);
    d.halo.scale.setScalar(haloSz);
    d.core.scale.setScalar(coreSz);
    if (this.dots.length >= TRAIL_COUNT) this.remove(this.dots.shift()!);
    d.age = 0; d.life = life; d.haloSz = haloSz; d.coreSz = coreSz;
    this.dots.push(d);
  }

  fade(dt: number): void {
    for (let i = this.dots.length - 1; i >= 0; i--) {
      const d = this.dots[i];
      d.age += dt;
      if (d.age >= d.life) {
        this.remove(d);
        this.dots.splice(i, 1);
      } else {
        const t = 1.0 - d.age / d.life;
        d.halo.material.opacity = t * 0.28;
        d.core.material.opacity = t * 0.7;
        d.core.scale.setScalar(d.coreSz * (0.4 + 0.6 * t));
        d.halo.scale.setScalar(d.haloSz * (0.7 + 0.3 * t));
      }
    }
  }

  private remove(d: TrailDot): void {
    this.scene.remove(d.halo);
    this.scene.remove(d.core);
    this.pool.push(d); // pooled — materials reused, nothing disposed
  }

  dispose(): void {
    for (const d of this.dots) this.remove(d);
    this.dots = [];
    for (const d of this.pool) {
      d.halo.material.dispose();
      d.core.material.dispose();
    }
    this.pool = [];
  }
}
