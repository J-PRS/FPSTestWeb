import * as THREE from 'three';

import { getGlowTexture } from './glowTexture.js';
import { markProbe } from '../core/fxDiag.js';
import type { Terrain } from '../world/terrain.js';

// Ground mist — a handful of large soft billboards pooled in terrain
// valleys. The classic "rolling fog banks" trick: no volumetrics, just big
// low-alpha glow sprites hovering a couple meters over low ground and
// yaw-facing the camera. ~8 draw calls total.
const CARD_COUNT = 9;
const SAMPLE_RANGE = 350;   // anchors are searched within ±this of origin
const SAMPLES = 220;        // candidate points evaluated for lowest spots
const WANDER = 2.5;         // slow drift amplitude (m)
const WIND_X = 1, WIND_Z = 0.1; // shared with volumetricClouds — banks flow the same direction the sky does
const WIND_DRIFT = 3;       // m/s downwind, wraps so banks never leave their valleys
const WIND_WRAP = 60;

interface Card {
  mesh: THREE.Mesh;
  baseX: number;
  baseZ: number;
  phase: number;
}

export class GroundMist {
  private cards: Card[] = [];

  constructor(scene: THREE.Scene, terrain: Terrain) {
    // Find the lowest local spots — mist physically pools in basins, which
    // is exactly what makes this read as weather instead of random sprites.
    const candidates: { x: number; z: number; h: number }[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const x = (Math.random() * 2 - 1) * SAMPLE_RANGE;
      const z = (Math.random() * 2 - 1) * SAMPLE_RANGE;
      candidates.push({ x, z, h: terrain.getHeightVisual(x, z) });
    }
    candidates.sort((a, b) => a.h - b.h);

    const geo = new THREE.PlaneGeometry(16, 6);
    const tex = getGlowTexture(128);
    for (let i = 0; i < CARD_COUNT; i++) {
      const spot = candidates[i % candidates.length]!;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: 0xBCC8D8,
        transparent: true,
        opacity: 0.055 + Math.random() * 0.03,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      // Random spread around the valley floor, squashed card hovering low
      const x = spot.x + (Math.random() - 0.5) * 30;
      const z = spot.z + (Math.random() - 0.5) * 30;
      mesh.position.set(x, terrain.getHeightVisual(x, z) + 2.2 + Math.random() * 1.5, z);
      mesh.renderOrder = 1;
      markProbe(mesh, { kind: 'fxMesh', label: 'groundMist' });
      scene.add(mesh);
      this.cards.push({ mesh, baseX: x, baseZ: z, phase: Math.random() * Math.PI * 2 });
    }
  }

  private time = 0;
  private active = true;

  /** Dynamic-quality switch — hides the cards and skips the billboard
   *  wander so CPU-throttled machines shed the whole cost. */
  setActive(on: boolean): void {
    this.active = on;
    for (const c of this.cards) {c.mesh.visible = on;}
  }

  update(dt: number, camPos: THREE.Vector3): void {
    if (!this.active) {return;}
    this.time += dt;
    for (const c of this.cards) {
      // Cylindrical billboard — yaw toward camera only, cards stay upright
      c.mesh.rotation.y = Math.atan2(camPos.x - c.mesh.position.x, camPos.z - c.mesh.position.z);
      // Slow wander — banks drift, never teleport
      const windT = ((this.time * WIND_DRIFT + c.phase * 10) % WIND_WRAP) - WIND_WRAP / 2;
      c.mesh.position.x = c.baseX + Math.sin(this.time * 0.05 + c.phase) * WANDER + windT * WIND_X;
      c.mesh.position.z = c.baseZ + Math.cos(this.time * 0.04 + c.phase * 2) * WANDER + windT * WIND_Z;
    }
  }
}
