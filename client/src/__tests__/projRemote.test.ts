import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { tickRemote } from '../projectiles/projRemote';
import type { Projectile } from '../projectiles/Projectile';
import type { ProjectileConfig } from '../projectiles/types';
import type { Terrain } from '../world/terrain';

const flatTerrain = { getHeight: () => 0 } as unknown as Terrain;

// Minimal SweepHost stand-in — tickRemote only reads config/canBounce/
// rayFired, runs sweepTerrain on pos/prevPos, then explode()/stickAt().
function remoteHost(config: Partial<ProjectileConfig>, from: [number, number, number], to: [number, number, number]) {
  const h = {
    pos: new THREE.Vector3(...to),
    prevPos: new THREE.Vector3(...from),
    config: { bodyRadius: 0.2, terrainOffset: 0.3, ...config } as ProjectileConfig,
    canBounce: false,
    rayFired: false,
    exploded: false,
    stuck: false,
    hitPoint: new THREE.Vector3(),
    hitPointValid: false,
    glue: { stickAt: () => { h.stuck = true; } },
    explode() { h.exploded = true; },
  };
  return h as unknown as Projectile & { exploded: boolean; stuck: boolean };
}

describe('tickRemote', () => {
  it('pops a contact-fused replica (no armTime/bounce/stick/embed) on terrain', () => {
    // Plasma-shaped config: the server's destroy edge is a loss-prone
    // hint — without a terrain sweep the replica streaks ~870m through
    // the world until the 10s backstop.
    const h = remoteHost({}, [0, 5, 0], [0, -5, 0]);
    expect(tickRemote(h, flatTerrain)).toBe(true);
    expect(h.exploded).toBe(true);
  });

  it('leaves the same replica alive while airborne', () => {
    const h = remoteHost({}, [0, 5, 0], [10, 5, 0]);
    expect(tickRemote(h, flatTerrain)).toBe(false);
    expect(h.exploded).toBe(false);
  });
});
