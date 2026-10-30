import * as THREE from 'three';

import { getGlowTexture } from './glowTexture.js';
import { markProbe } from '../core/fxDiag.js';
import type { Terrain } from '../world/terrain.js';

// Ground mist - a handful of large soft billboards pooled in terrain
// valleys. The classic "rolling fog banks" trick: no volumetrics, just big
// low-alpha glow sprites hovering a couple meters over low ground and
// yaw-facing the camera. One InstancedMesh - 9 draws became 1; the
// per-card opacity jitter (±0.015) was invisible noise.
const CARD_COUNT = 9;
const SAMPLE_RANGE = 350;   // anchors are searched within ±this of origin
const SAMPLES = 220;        // candidate points evaluated for lowest spots
const WANDER = 2.5;         // slow drift amplitude (m)
const WIND_X = 1, WIND_Z = 0.1; // shared with volumetricClouds - banks flow the same direction the sky does
const WIND_DRIFT = 3;       // m/s downwind, wraps so banks never leave their valleys
const WIND_WRAP = 60;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);

interface Card {
  x: number; z: number; y: number;
  baseX: number; baseZ: number;
  phase: number;
}

export class GroundMist {
  private cards: Card[] = [];
  private mesh: THREE.InstancedMesh;

  constructor(scene: THREE.Scene, terrain: Terrain) {
    // Find the lowest local spots - mist physically pools in basins, which
    // is exactly what makes this read as weather instead of random sprites.
    const candidates: { x: number; z: number; h: number }[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const x = (Math.random() * 2 - 1) * SAMPLE_RANGE;
      const z = (Math.random() * 2 - 1) * SAMPLE_RANGE;
      candidates.push({ x, z, h: terrain.getHeightVisual(x, z) });
    }
    candidates.sort((a, b): number => a.h - b.h);

    const geo = new THREE.PlaneGeometry(16, 6);
    const tex = getGlowTexture(128);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: 0xBC_C8_D8,
      transparent: true,
      opacity: 0.065,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, CARD_COUNT);
    this.mesh.count = CARD_COUNT;
    this.mesh.frustumCulled = false; // cards span the map
    this.mesh.renderOrder = 1;
    markProbe(this.mesh, { kind: 'fxMesh', label: 'groundMist' });
    scene.add(this.mesh);
    for (let i = 0; i < CARD_COUNT; i += 1) {
      const spot = candidates[i % candidates.length]!;
      // Random spread around the valley floor, squashed card hovering low
      const x = spot.x + (Math.random() - 0.5) * 30;
      const z = spot.z + (Math.random() - 0.5) * 30;
      const y = terrain.getHeightVisual(x, z) + 2.2 + Math.random() * 1.5;
      this.cards.push({ x, z, y, baseX: x, baseZ: z, phase: Math.random() * Math.PI * 2 });
      this.mesh.setMatrixAt(i, _m.identity());
    }
  }

  private time = 0;
  private active = true;

  /** Dynamic-quality switch - hides the cards and skips the billboard
   *  wander so CPU-throttled machines shed the whole cost. */
  setActive(on: boolean): void {
    this.active = on;
    this.mesh.visible = on;
  }

  update(dt: number, camPos: THREE.Vector3): void {
    if (!this.active) {return;}
    this.time += dt;
    for (let i = 0; i < this.cards.length; i += 1) {
      const c = this.cards[i]!;
      // Cylindrical billboard - yaw toward camera only, cards stay upright
      const yaw = Math.atan2(camPos.x - c.x, camPos.z - c.z);
      // Slow wander - banks drift, never teleport
      const windT = ((this.time * WIND_DRIFT + c.phase * 10) % WIND_WRAP) - WIND_WRAP / 2;
      c.x = c.baseX + Math.sin(this.time * 0.05 + c.phase) * WANDER + windT * WIND_X;
      c.z = c.baseZ + Math.cos(this.time * 0.04 + c.phase * 2) * WANDER + windT * WIND_Z;
      this.mesh.setMatrixAt(i, _m.compose(
        _p.set(c.x, c.y, c.z),
        _q.setFromEuler(_e.set(0, yaw, 0)),
        _s,
      ));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
