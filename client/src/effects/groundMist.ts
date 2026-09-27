import * as THREE from 'three';

import { getGlowTexture } from './glowTexture.js';
import type { Terrain } from '../world/terrain.js';

// Ground mist — a handful of large soft billboards pooled in terrain
// valleys. The classic "rolling fog banks" trick: no volumetrics, just big
// low-alpha glow sprites hovering a couple meters over low ground and
// yaw-facing the camera. ~8 draw calls total.
const CARD_COUNT = 9;
const SAMPLE_RANGE = 350;   // anchors are searched within ±this of origin
const SAMPLES = 220;        // candidate points evaluated for lowest spots
const WANDER = 2.5;         // slow drift amplitude (m)

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
      candidates.push({ x, z, h: terrain.getHeight(x, z) });
    }
    candidates.sort((a, b) => a.h - b.h);

    const geo = new THREE.PlaneGeometry(16, 6);
    const tex = getGlowTexture(128);
    for (let i = 0; i < CARD_COUNT; i++) {
      const spot = candidates[i % candidates.length]!;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: 0xbcc8d8,
        transparent: true,
        opacity: 0.055 + Math.random() * 0.03,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      // Random spread around the valley floor, squashed card hovering low
      const x = spot.x + (Math.random() - 0.5) * 30;
      const z = spot.z + (Math.random() - 0.5) * 30;
      mesh.position.set(x, terrain.getHeight(x, z) + 2.2 + Math.random() * 1.5, z);
      mesh.renderOrder = 1;
      scene.add(mesh);
      this.cards.push({ mesh, baseX: x, baseZ: z, phase: Math.random() * Math.PI * 2 });
    }
  }

  private time = 0;

  update(dt: number, camPos: THREE.Vector3): void {
    this.time += dt;
    for (const c of this.cards) {
      // Cylindrical billboard — yaw toward camera only, cards stay upright
      c.mesh.rotation.y = Math.atan2(camPos.x - c.mesh.position.x, camPos.z - c.mesh.position.z);
      // Slow wander — banks drift, never teleport
      c.mesh.position.x = c.baseX + Math.sin(this.time * 0.05 + c.phase) * WANDER;
      c.mesh.position.z = c.baseZ + Math.cos(this.time * 0.04 + c.phase * 2) * WANDER;
    }
  }
}
