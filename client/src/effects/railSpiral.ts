/**
 * railSpiral — Quake 2 railgun corkscrew. A thin billboard ribbon whose
 * samples are laid on a helix around the flight path, layered OVER the
 * straight core lanes (which this does not touch). Q2 draws the whole
 * coil instantly on a hitscan ray; ours is a real projectile, so the
 * helix is painted progressively behind the shell.
 *
 * One frame at ~450 m/s hops ~7.5 m — far too coarse to resolve a turn,
 * so push() re-samples the frame's travel into sub-step helix points.
 * Phase is a function of distance traveled, not time, so the coil shape
 * is speed-independent.
 */
import * as THREE from 'three';
import { RibbonTrail } from './RibbonTrail.js';
import type { DriveRibbon } from './vfxRuntime.js';
import type { ProjectileConfig } from '../projectiles/types.js';

const RADIUS = 0.55;      // coil radius around the core beam
const WAVELENGTH = 8;     // meters per full turn
const STEP = 0.7;         // meters between samples (~11 points per turn)
const WIDTH = 0.14;
const LIFE = 0.35;
const TWO_PI = Math.PI * 2;
// Ring buffer is 48 samples — a step this small means the coil covers
// ~34 m of tail behind the shell regardless of speed.
const MAX_DIST = 60;      // beyond this it's a missed jump-cut, not travel

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upAxis = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _FWD = new THREE.Vector3(1, 0, 0);
const _WHITE = new THREE.Color(0xFF_FF_FF);

export class RailSpiral implements DriveRibbon {
  readonly ribbon: RibbonTrail;
  /** TrailDriver binds the host pos here for head re-pinning — accepted
   *  and deliberately unused: the coil head lives OFF the centerline, so
   *  pinning it would kink the newest segment onto the beam. */
  follow: THREE.Vector3 | null = null;
  private readonly last = new THREE.Vector3(Number.NaN, 0, 0);
  private phase = 0;
  // Distance traveled — drives the muzzle ramp so the coil swells from a
  // point to full radius over the first ~0.1s of flight (the visible
  // "thickness" is the helix radius, not the ribbon width).
  private traveled = 0;

  constructor(scene: THREE.Scene, config: ProjectileConfig) {
    const base = config.ribbonColor ?? config.trailColors[0]?.getHex() ?? 0xFF_FF_FF;
    const color = new THREE.Color(base).lerp(_WHITE, 0.45).getHex();
    this.ribbon = RibbonTrail.acquire(scene, {
      color, width: WIDTH, life: LIFE, billboard: true,
      tag: `proj:${config.name}:coil`,
    });
    // Muzzle ramp: coil grows 0→full width over 0.1s so it doesn't pop
    // in as a fat ring right at the eye.
    this.ribbon.rampIn(0.1, 0);
  }

  /** DriveRibbon entry — the driver calls this once per frame with the
   *  host pos; we walk last→pos in STEP chunks and drop a helix-offset
   *  sample at each so the coil resolves instead of aliasing. */
  push(pos: THREE.Vector3, vel: THREE.Vector3): void {
    const spd = vel.length();
    if (spd < 1) { this.last.copy(pos); return; }
    _dir.copy(vel).divideScalar(spd);
    _right.crossVectors(_dir, Math.abs(_dir.y) < 0.95 ? _UP : _FWD).normalize();
    _upAxis.crossVectors(_right, _dir);
    const dist = Number.isFinite(this.last.x) ? this.last.distanceTo(pos) : 0;
    // Jumps are normally cut by the driver's clear() first; a surviving
    // giant step means a missed cut — resync, never paint a coil chord.
    if (dist <= 0 || dist > MAX_DIST) { this.last.copy(pos); return; }
    this.traveled += dist;
    while (this.last.distanceToSquared(pos) >= STEP * STEP) {
      this.last.addScaledVector(_dir, STEP);
      this.phase += (STEP / WAVELENGTH) * TWO_PI;
      // Radius ramp: seconds of flight = meters / mps, so the coil is a
      // tight thread leaving the muzzle and reaches full turn by 0.1s.
      const ramp = Math.min(1, this.traveled / (spd * 0.1));
      const r = RADIUS * ramp;
      const c = Math.cos(this.phase) * r, s = Math.sin(this.phase) * r;
      _pt.copy(this.last).addScaledVector(_upAxis, c).addScaledVector(_right, s);
      this.ribbon.push(_pt, vel);
    }
    // Fold the sub-step remainder into phase so the next frame's coil
    // continues the same rotation instead of restarting its angle.
    this.phase += (this.last.distanceTo(pos) / WAVELENGTH) * TWO_PI;
    this.last.copy(pos);
  }

  /** DriveRibbon entry — driver's jump cut. */
  clear(): void {
    this.ribbon.clear();
    this.last.set(Number.NaN, 0, 0);
  }

  update(dt: number): void { this.ribbon.update(dt); }
  stop(): void { this.ribbon.stop(); }
  dispose(): void { this.ribbon.dispose(); }
  get done(): boolean { return this.ribbon.done; }
  dbg(): ReturnType<RibbonTrail['dbg']> { return this.ribbon.dbg(); }
}
