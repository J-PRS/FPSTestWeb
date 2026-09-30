import * as THREE from 'three';

import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';

const MAX_SAMPLES = 48;

const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(1, 0, 0);
const _dir = new THREE.Vector3();

/**
 * Flat ribbon trail — a single triangle strip following the projectile.
 * One draw call, zero per-frame allocations; much cheaper than particle meshes.
 *
 * The ribbon is offset perpendicular to the velocity in the horizontal-ish
 * plane (like a frisbee slicing air). Fades to black toward the tail; with
 * AdditiveBlending black = invisible.
 */
export class RibbonTrail {
  private mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.MeshBasicMaterial;

  // Ring buffer of samples: position + side vector + emit time
  private px = new Float32Array(MAX_SAMPLES);
  private py = new Float32Array(MAX_SAMPLES);
  private pz = new Float32Array(MAX_SAMPLES);
  private sx = new Float32Array(MAX_SAMPLES);
  private sy = new Float32Array(MAX_SAMPLES);
  private sz = new Float32Array(MAX_SAMPLES);
  private st = new Float32Array(MAX_SAMPLES);
  private head = -1; // index of newest sample
  private count = 0;
  private time = 0;
  private stopped = false;

  // Direction per sample — needed by billboard mode to derive the camera-facing
  // side vector at update time (side can't be frozen at push since view moves)
  private dx = new Float32Array(MAX_SAMPLES);
  private dy = new Float32Array(MAX_SAMPLES);
  private dz = new Float32Array(MAX_SAMPLES);

  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private baseColor: THREE.Color;
  private width: number;
  private life: number;
  private vOffset: number; // offset along the ribbon's in-plane "up" (⊥ side)
  private billboard: boolean; // width axis faces the camera each frame

  // Free-list — projectiles churn ribbons constantly; buffers are fixed-size
  // so reuse is free. Pool is split by billboard mode (structural difference).
  private static poolFixed: RibbonTrail[] = [];
  private static poolBillboard: RibbonTrail[] = [];

  static acquire(scene: THREE.Scene, color: number, width = 0.5, life = 0.3, vOffset = 0, billboard = false): RibbonTrail {
    const pool = billboard ? RibbonTrail.poolBillboard : RibbonTrail.poolFixed;
    const r = pool.pop();
    if (r) {
      r.reinit(scene, color, width, life, vOffset);
      return r;
    }
    return new RibbonTrail(scene, color, width, life, vOffset, billboard);
  }

  private reinit(scene: THREE.Scene, color: number, width: number, life: number, vOffset: number): void {
    this.width = width;
    this.life = life;
    this.vOffset = vOffset;
    this.baseColor.setHex(color);
    this.stopped = false;
    this.time = 0;
    this.head = -1;
    this.count = 0;
    this.geo.setDrawRange(0, 0);
    scene.add(this.mesh);
  }

  private constructor(scene: THREE.Scene, color: number, width = 0.5, life = 0.3, vOffset = 0, billboard = false) {
    this.width = width;
    this.life = life;
    this.vOffset = vOffset;
    this.billboard = billboard;
    this.baseColor = new THREE.Color(color);

    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX_SAMPLES * 2 * 3), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(MAX_SAMPLES * 2 * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('color', this.colAttr);

    // Static index strip: quad between consecutive sample pairs
    const idx = new Uint16Array((MAX_SAMPLES - 1) * 6);
    for (let i = 0; i < MAX_SAMPLES - 1; i++) {
      const o = i * 6, v = i * 2;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v + 1; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);

    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false; // vertices update every frame; skip bounds math
    this.mesh.layers.enable(BLOOM_LAYER);
    scene.add(this.mesh);
  }

  /** Record a new sample at the projectile's current position/facing. */
  push(pos: THREE.Vector3, vel: THREE.Vector3): void {
    if (this.stopped) return;
    _dir.copy(vel);
    if (_dir.lengthSq() < 1e-6) return;
    _dir.normalize();
    // Side vector: perpendicular to velocity, biased to the world-horizontal plane
    _side.crossVectors(_dir, Math.abs(_dir.y) < 0.95 ? _up : _fwd).normalize();

    // Lane offset along the ribbon plane's "up" (⊥ both dir and side)
    let ox = 0, oy = 0, oz = 0;
    if (this.vOffset !== 0) {
      ox = (_dir.y * _side.z - _dir.z * _side.y) * -this.vOffset;
      oy = (_dir.z * _side.x - _dir.x * _side.z) * -this.vOffset;
      oz = (_dir.x * _side.y - _dir.y * _side.x) * -this.vOffset;
    }

    this.head = (this.head + 1) % MAX_SAMPLES;
    this.px[this.head] = pos.x + ox; this.py[this.head] = pos.y + oy; this.pz[this.head] = pos.z + oz;
    this.sx[this.head] = _side.x; this.sy[this.head] = _side.y; this.sz[this.head] = _side.z;
    this.dx[this.head] = _dir.x; this.dy[this.head] = _dir.y; this.dz[this.head] = _dir.z;
    this.st[this.head] = this.time;
    if (this.count < MAX_SAMPLES) this.count++;
  }

  /** Stop emitting — ribbon fades out where it is. */
  stop(): void { this.stopped = true; }

  /** Drop all samples — call after a position discontinuity (teleport/respawn)
   *  so the ribbon doesn't stretch a streak across the jump. */
  clear(): void {
    this.head = -1;
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }

  /** True once the last sample has fully faded — safe to dispose. */
  get done(): boolean {
    if (this.count === 0) return true;
    return this.time - this.st[this.head] > this.life;
  }

  update(dt: number, camPos?: THREE.Vector3): void {
    this.time += dt;
    if (this.count < 2) { this.geo.setDrawRange(0, 0); return; }

    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    // EMIT_GAIN: vertex colors go HDR-hot so the ribbon clears the bloom
    // threshold; ACES brings the display color back to the authored hue.
    const r = this.baseColor.r * EMIT_GAIN, g = this.baseColor.g * EMIT_GAIN, b = this.baseColor.b * EMIT_GAIN;

    for (let i = 0; i < this.count; i++) {
      // oldest -> newest
      const s = (this.head - this.count + 1 + i + MAX_SAMPLES) % MAX_SAMPLES;
      const fade = Math.max(0, 1 - (this.time - this.st[s]) / this.life);
      // taper width toward the tail and toward faded samples
      const w = this.width * 0.5 * fade;
      const o = i * 6;
      let sx = this.sx[s], sy = this.sy[s], sz = this.sz[s];
      if (this.billboard && camPos) {
        // Side = dir x (dir to camera): ribbon plane always faces the viewer
        const vx = camPos.x - this.px[s], vy = camPos.y - this.py[s], vz = camPos.z - this.pz[s];
        sx = this.dy[s] * vz - this.dz[s] * vy;
        sy = this.dz[s] * vx - this.dx[s] * vz;
        sz = this.dx[s] * vy - this.dy[s] * vx;
        const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
        if (len > 1e-6) { sx /= len; sy /= len; sz /= len; }
        else { sx = this.sx[s]; sy = this.sy[s]; sz = this.sz[s]; }
      }
      pos[o] = this.px[s] - sx * w;
      pos[o + 1] = this.py[s] - sy * w;
      pos[o + 2] = this.pz[s] - sz * w;
      pos[o + 3] = this.px[s] + sx * w;
      pos[o + 4] = this.py[s] + sy * w;
      pos[o + 5] = this.pz[s] + sz * w;
      const cr = r * fade, cg = g * fade, cb = b * fade;
      col[o] = cr; col[o + 1] = cg; col[o + 2] = cb;
      col[o + 3] = cr; col[o + 4] = cg; col[o + 5] = cb;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.geo.setDrawRange(0, (this.count - 1) * 6);
  }

  /** Release back to the pool — buffers/material kept for reuse. */
  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    const pool = this.billboard ? RibbonTrail.poolBillboard : RibbonTrail.poolFixed;
    pool.push(this);
  }
}
