import * as THREE from 'three';

import { getGlowTexture } from './glowTexture.js';
import { markProbe } from '../core/fxDiag.js';
import type { Terrain } from '../world/terrain.js';

// Ambient world particles — dust motes / embers / falling ash drifting
// through the air around the player. Each kind is a single THREE.Points
// cloud (one draw call, zero per-frame allocation).
//
// Distribution: each mote has a short life; on expiry it respawns at a
// uniform-random point inside a sphere around the camera (ember/ash kinds
// bias the spawn height — embers seed near the ground, ash falls from
// above). Particles live in world space, so flying through them gives true
// relative motion — they read as part of the world, not a screen overlay.
export type AmbientKind = 'dust' | 'embers' | 'ash';

interface KindConfig {
  count: number;
  size: number;
  opacity: number;
  vel: { x: number; y: number; z: number };
  velSpread: number;   // per-particle random velocity on top of base drift
  wobble: number;      // sine wobble amplitude (m/s)
  blink: boolean;      // ember/firefly flicker — color attribute goes black
  spawnY: 'shell' | 'ground' | 'sky'; // respawn height band
  colors(): THREE.Color;
}

const R_MIN = 4;         // keep motes off the near plane — an additive glow
                         // sprite at arm's length is a white blob
const R_MAX = 30;        // respawn shell outer radius (m)
const KILL_R = 45;       // outrun one this far and it reseeds
const LIFE_MIN = 5;
const LIFE_MAX = 12;

const _c = new THREE.Color();

const KINDS: Record<AmbientKind, KindConfig> = {
  // Lazy floating dust/pollen — the baseline field
  dust: {
    count: 220, size: 0.14, opacity: 0.22,
    vel: { x: 1.4, y: 0.15, z: 0.6 }, velSpread: 0.4,
    wobble: 0.6, blink: false, spawnY: 'shell',
    colors: () => Math.random() < 0.15
      ? _c.setRGB(0.55, 0.85, 1.0)
      : _c.setRGB(1.0, 0.9 + Math.random() * 0.1, 0.65 + Math.random() * 0.2),
  },
  // Embers — sparse warm sparks that rise off the ground and blink.
  // Blink works by writing black into the color attribute: additive
  // blending makes black invisible.
  embers: {
    count: 60, size: 0.1, opacity: 0.5,
    vel: { x: 0.4, y: 0.8, z: 0.2 }, velSpread: 0.6,
    wobble: 1.0, blink: true, spawnY: 'ground',
    colors: () => _c.setRGB(1.0, 0.45 + Math.random() * 0.2, 0.1),
  },
  // Ash fall — gray-white flecks settling slowly, heavier sway
  ash: {
    count: 120, size: 0.16, opacity: 0.18,
    vel: { x: 0.9, y: -0.7, z: 0.5 }, velSpread: 0.5,
    wobble: 1.2, blink: false, spawnY: 'sky',
    colors: () => {
      const g = 0.55 + Math.random() * 0.3;
      return _c.setRGB(g, g, g * 0.95);
    },
  },
};

export class AmbientParticles {
  private points: THREE.Points;
  private posAttr: THREE.BufferAttribute;
  private colorAttr: THREE.BufferAttribute;
  private baseColors: Float32Array; // blink restores from this
  private phases: Float32Array;
  private speeds: Float32Array;
  private vels: Float32Array; // per-particle random vel offset, xyz
  private life: Float32Array;
  private time = 0;
  private seeded = false;

  constructor(scene: THREE.Scene, kind: AmbientKind = 'dust') {
    const cfg = KINDS[kind];
    const n = cfg.count;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    this.baseColors = new Float32Array(n * 3);
    this.phases = new Float32Array(n);
    this.speeds = new Float32Array(n);
    this.vels = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.cfg = cfg;

    for (let i = 0; i < n; i++) {
      this.phases[i] = Math.random() * Math.PI * 2;
      this.speeds[i] = 0.5 + Math.random() * 1.5;
      this.vels[i * 3] = cfg.vel.x + (Math.random() - 0.5) * cfg.velSpread;
      this.vels[i * 3 + 1] = cfg.vel.y + (Math.random() - 0.5) * cfg.velSpread;
      this.vels[i * 3 + 2] = cfg.vel.z + (Math.random() - 0.5) * cfg.velSpread;
      this.life[i] = Math.random() * LIFE_MAX; // staggered — no mass respawn
      cfg.colors().toArray(colors, i * 3);
      cfg.colors().toArray(this.baseColors, i * 3);
    }

    this.posAttr = new THREE.BufferAttribute(pos, 3);
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colorAttr);

    const mat = new THREE.PointsMaterial({
      size: cfg.size,
      map: getGlowTexture(),
      vertexColors: true,
      transparent: true,
      opacity: cfg.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false; // positions move every frame — a stale bounding sphere would clip it
    scene.add(this.points);
    markProbe(this.points, { kind: 'fxMesh', label: 'ambientParticles' });
  }

  /** Dynamic-quality switch — hides the cloud and skips the per-frame
   *  integration so CPU-throttled machines shed the whole cost. */
  setActive(on: boolean): void { this.points.visible = on; this.active = on; }
  private active = true;

  private cfg: KindConfig;

  // Uniform-random point in the spherical shell around the camera,
  // re-banded by spawnY and kept above local terrain.
  private respawn(i: number, camPos: THREE.Vector3, terrain: Terrain): void {
    const ix = i * 3;
    const p = this.posAttr.array as Float32Array;
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = R_MIN + (R_MAX - R_MIN) * Math.cbrt(Math.random());
    p[ix] = camPos.x + s * Math.cos(th) * r;
    p[ix + 2] = camPos.z + s * Math.sin(th) * r;

    const ground = terrain.getHeightVisual(p[ix]!, p[ix + 2]!) + 0.3;
    if (this.cfg.spawnY === 'ground') {
      p[ix + 1] = ground + Math.random() * 2;
    } else if (this.cfg.spawnY === 'sky') {
      p[ix + 1] = Math.max(camPos.y + u * r, ground) + 6 + Math.random() * 12;
    } else {
      p[ix + 1] = Math.max(camPos.y + u * r, ground + Math.random() * 2);
    }

    this.life[i] = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    this.phases[i] = Math.random() * Math.PI * 2;
  }

  update(dt: number, camPos: THREE.Vector3, terrain: Terrain): void {
    if (!this.active) return;
    this.time += dt;
    const cfg = this.cfg;
    const n = cfg.count;
    const p = this.posAttr.array as Float32Array;

    // First tick: seed the whole field around wherever the camera started.
    if (!this.seeded) {
      this.seeded = true;
      for (let i = 0; i < n; i++) this.respawn(i, camPos, terrain);
      this.posAttr.needsUpdate = true;
      return;
    }

    let colorDirty = false;
    const colors = this.colorAttr.array as Float32Array;

    for (let i = 0; i < n; i++) {
      const ix = i * 3;
      this.life[i]! -= dt;

      const dx = p[ix]! - camPos.x;
      const dy = p[ix + 1]! - camPos.y;
      const dz = p[ix + 2]! - camPos.z;
      if (this.life[i]! <= 0 || dx * dx + dy * dy + dz * dz > KILL_R * KILL_R) {
        this.respawn(i, camPos, terrain);
        continue;
      }

      const phase = this.phases[i]!;
      const spd = this.speeds[i]!;
      p[ix]! += (this.vels[ix]! + Math.sin(this.time * spd + phase) * cfg.wobble) * dt;
      p[ix + 1]! += (this.vels[ix + 1]! + Math.cos(this.time * spd * 0.7 + phase * 2) * cfg.wobble * 0.5) * dt;
      p[ix + 2]! += (this.vels[ix + 2]! + Math.sin(this.time * spd * 0.5 + phase * 3) * cfg.wobble) * dt;

      // Ember/firefly blink — slow sine gate; black adds nothing under
      // additive blending so the mote just vanishes and rekindles.
      if (cfg.blink) {
        const gate = Math.sin(this.time * spd * 1.7 + phase * 5);
        const k = Math.min(Math.max((gate + 0.4) / 0.8, 0), 1); // smooth fade, no pop
        colors[ix] = this.baseColors[ix]! * k;
        colors[ix + 1] = this.baseColors[ix + 1]! * k;
        colors[ix + 2] = this.baseColors[ix + 2]! * k;
        colorDirty = true;
      }
    }

    this.posAttr.needsUpdate = true;
    if (colorDirty) this.colorAttr.needsUpdate = true;
  }
}
