import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { sweepTerrain, sweepPlayer, sweepObstacle, type SweepHost } from '../projectiles/sweep';
import { PLAYER_RADIUS, CAPSULE_CENTER_Y, EYE_OFFSET } from '../core/config';
import type { ProjectileConfig } from '../projectiles/types';
import type { SweepObstacle } from '../projectiles/Projectile';

// Flat ground at y=0 — the host is a plain object, no scene needed.
const flatTerrain = { getHeight: () => 0 } as any;

function host(over: Partial<SweepHost> & { from?: [number, number, number]; to?: [number, number, number]; config?: Partial<ProjectileConfig> } = {}) {
  const hits: { x: number; y: number; z: number; t: number }[] = [];
  const h: SweepHost & { hits: typeof hits } = {
    pos: new THREE.Vector3(...(over.to ?? [0, 1, 0])),
    prevPos: new THREE.Vector3(...(over.from ?? [0, 1, 0])),
    config: ((((((Object.assign({}, {bodyRadius: 0.2,terrainOffset: 0.3,hitMin: 0,hitRate: 0}, over.config))))))) as ProjectileConfig,
    canBounce: over.canBounce ?? false,
    hitRadius: over.hitRadius ?? 0,
    hitPoint: new THREE.Vector3(),
    hitPointValid: false,
    minHitDist: 0,
    directHit: false,
    wakeBallDistances: new Map(),
    wakePlayerDistances: new Map(),
    hits,
    hitAt(x, y, z, t) { hits.push({ x, y, z, t }); this.hitPoint.set(x, y, z); this.hitPointValid = true; },
  };
  return h;
}

describe('sweepTerrain', () => {
  it('hits ground on a downward arc and refines hitPoint near the crossing', () => {
    const h = host({ from: [0, 5, 0], to: [0, -5, 0] });
    expect(sweepTerrain(h, flatTerrain)).toBe(true);
    // offset 0.3 → contact where y crosses 0.3, i.e. t≈0.47 → y≈0.3
    expect(h.hitPoint.y).toBeCloseTo(0.3, 1);
  });

  it('misses a path that stays above ground', () => {
    const h = host({ from: [0, 5, 0], to: [10, 5, 0] });
    expect(sweepTerrain(h, flatTerrain)).toBe(false);
    expect(h.hitPointValid).toBe(false);
  });
});

describe('sweepPlayer', () => {
  // Eye pos for a player standing at (0,0,0): y = EYE_OFFSET.
  const eye = new THREE.Vector3(0, EYE_OFFSET, 0);

  it('direct hit through the capsule center', () => {
    const h = host({ from: [-5, CAPSULE_CENTER_Y, 0], to: [5, CAPSULE_CENTER_Y, 0] });
    expect(sweepPlayer(h, eye, 'p1')).toBe(true);
    expect(h.directHit).toBe(true);
    expect(h.minHitDist).toBeLessThan(PLAYER_RADIUS);
  });

  it('misses a sweep past the capsule', () => {
    const h = host({ from: [-5, 30, 0], to: [5, 30, 0] });
    expect(sweepPlayer(h, eye, 'p1')).toBe(false);
  });

  it('wake hit only fires after passing closest approach', () => {
    // Expanding radius 2: sweep that grazes — distance never under core.
    const from: [number, number, number] = [-5, CAPSULE_CENTER_Y, 1.5];
    const mid: [number, number, number] = [0.5, CAPSULE_CENTER_Y, 1.5]; // just past closest approach
    const to: [number, number, number] = [5, CAPSULE_CENTER_Y, 1.5];
    // Frame 1: approaching — inside wake but still closing → no hit yet
    const h = host({ from, to: mid, hitRadius: 2 });
    expect(sweepPlayer(h, eye, 'p1')).toBe(false);
    // Frame 2: past closest point, distance growing → wake fires
    h.prevPos.copy(h.pos); h.pos.set(...to);
    expect(sweepPlayer(h, eye, 'p1')).toBe(true);
    expect(h.directHit).toBe(false);
  });
});

describe('sweepObstacle', () => {
  it('detects a crossing segment-vs-segment intercept', () => {
    const h = host({ from: [0, 0, -5], to: [0, 0, 5] });
    const bolt: SweepObstacle = {
      pos: new THREE.Vector3(3, 0, 0),      // moving across our path
      prevPos: new THREE.Vector3(-3, 0, 0),
      radius: 0.5,
    };
    expect(sweepObstacle(h, bolt)).toBe(true);
    expect(h.directHit).toBe(true);
    // Contact at t=0.5 where both cross the origin
    expect(h.hits[0]!.t).toBeCloseTo(0.5, 5);
  });

  it('misses when segments never come within radii', () => {
    const h = host({ from: [0, 0, -5], to: [0, 0, 5] });
    const bolt: SweepObstacle = {
      pos: new THREE.Vector3(10, 0, 0),
      prevPos: new THREE.Vector3(10, 0, 6),
      radius: 0.5,
    };
    expect(sweepObstacle(h, bolt)).toBe(false);
  });
});
