import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { sweepTerrain, sweepPlayer, sweepObstacle, sweepBall, type SweepHost } from '../projectiles/sweep';
import type { Targetable } from '../entities/balls.js';
import type { Terrain } from '../world/terrain.js';
import { PLAYER_RADIUS, CAPSULE_CENTER_Y, EYE_OFFSET } from '../core/config';
import type { ProjectileConfig } from '../projectiles/types';
import type { SweepObstacle } from '../projectiles/Projectile';

// Flat ground at y=0 — the host is a plain object, no scene needed.
const flatTerrain = { getHeight: (): number => 0 } as unknown as Terrain;

function host(over: Partial<SweepHost> & { from?: [number, number, number]; to?: [number, number, number]; config?: Partial<ProjectileConfig> } = {}): SweepHost & { hits: { x: number; y: number; z: number; t: number; }[]; } {
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
    hitAt(x, y, z, t): void { hits.push({ x, y, z, t }); this.hitPoint.set(x, y, z); this.hitPointValid = true; },
  };
  return h;
}

describe('sweepTerrain', (): void => {
  it('hits ground on a downward arc and refines hitPoint near the crossing', (): void => {
    const h = host({ from: [0, 5, 0], to: [0, -5, 0] });
    expect(sweepTerrain(h, flatTerrain)).toBe(true);
    // offset 0.3 → contact where y crosses 0.3, i.e. t≈0.47 → y≈0.3
    expect(h.hitPoint.y).toBeCloseTo(0.3, 1);
  });

  it('misses a path that stays above ground', (): void => {
    const h = host({ from: [0, 5, 0], to: [10, 5, 0] });
    expect(sweepTerrain(h, flatTerrain)).toBe(false);
    expect(h.hitPointValid).toBe(false);
  });
});

describe('sweepPlayer', (): void => {
  // Eye pos for a player standing at (0,0,0): y = EYE_OFFSET.
  const eye = new THREE.Vector3(0, EYE_OFFSET, 0);

  it('direct hit through the capsule center', (): void => {
    const h = host({ from: [-5, CAPSULE_CENTER_Y, 0], to: [5, CAPSULE_CENTER_Y, 0] });
    expect(sweepPlayer(h, eye, 'p1')).toBe(true);
    expect(h.directHit).toBe(true);
    expect(h.minHitDist).toBeLessThan(PLAYER_RADIUS);
  });

  it('misses a sweep past the capsule', (): void => {
    const h = host({ from: [-5, 30, 0], to: [5, 30, 0] });
    expect(sweepPlayer(h, eye, 'p1')).toBe(false);
  });

  it('wake hit only fires after passing closest approach', (): void => {
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

describe('sweepBall ghost pos', (): void => {
  const ball = (x: number, y: number, z: number): Targetable => ({
    id: 1, variant: 0, dead: false, health: 10, radius: 0.5, color: new THREE.Color(), scale: 1,
    pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(30, 0, 0),
    takeDamage: (): boolean => false, applyKnockback: (): void => {}, applyPull: (): void => {},
  } as Targetable);

  it('evaluates the ghost-rewound pos, not the live pos', (): void => {
    // Ball sits at (10,0,0) live but its ghost (150ms rewind of a 30m/s
    // mover) is at (5.5,0,0) — a shell through x≈5.5 hits the ghost.
    const b = ball(10, 0, 0);
    const h = host({ from: [4, 0, 0], to: [7, 0, 0] });
    expect(sweepBall(h, b)).toBe(false); // live pos is out of reach
    const ghost = new THREE.Vector3(5.5, 0, 0);
    expect(sweepBall(h, b, ghost)).toBe(true);
  });

  it('a live-pos hit can become a ghost-pos miss', (): void => {
    const b = ball(5.5, 0, 0);
    const h = host({ from: [4, 0, 0], to: [7, 0, 0] });
    expect(sweepBall(h, b)).toBe(true);
    const ghost = new THREE.Vector3(10, 0, 0);
    expect(sweepBall(h, b, ghost)).toBe(false);
  });
});

describe('sweepObstacle', (): void => {
  it('detects a crossing segment-vs-segment intercept', (): void => {
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

  it('misses when segments never come within radii', (): void => {
    const h = host({ from: [0, 0, -5], to: [0, 0, 5] });
    const bolt: SweepObstacle = {
      pos: new THREE.Vector3(10, 0, 0),
      prevPos: new THREE.Vector3(10, 0, 6),
      radius: 0.5,
    };
    expect(sweepObstacle(h, bolt)).toBe(false);
  });
});
