/* oxlint-disable typescript/no-explicit-any -- test stubs are deliberately loosely typed */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { spawnClusterBomblets } from '../game/combat/impact.js';
import type { Projectile } from '../projectiles/Projectile.js';
import type { CombatCtx } from '../game/combat.js';

// A carrier shell mid-air: enough Projectile surface for the scatter to
// read (config.cluster, vel, pos, hitPointValid, shooterId).
const carrier = (shooterId: string | null): any => ({
  config: {
    cluster: { count: 4, spread: 0.9, fuse: 0, sphere: true },
    bomblet: undefined,
    speed: 0,
    inherit: 0,
  },
  vel: new THREE.Vector3(10, 4, -6),
  pos: new THREE.Vector3(0, 50, 0),
  hitPointValid: false,
  shooterId,
});

const ctx = (projectiles: any[]): CombatCtx => ({
  deps: {
    lazyScene: (): THREE.Scene => new THREE.Scene(),
    world: { projectiles },
  },
} as unknown as CombatCtx);

describe('spawnClusterBomblets authorship', (): void => {
  it('bomblets inherit a remote carrier\'s shooterId - unset reads as MINE to the blast gates', (): void => {
    const projectiles: any[] = [];
    spawnClusterBomblets(ctx(projectiles), carrier('player-9') as Projectile);
    expect(projectiles).toHaveLength(4);
    for (const b of projectiles) {expect(b.shooterId).toBe('player-9');}
  });

  it('own carrier leaves bomblets unattributed - they stay my predicted damage', (): void => {
    const projectiles: any[] = [];
    spawnClusterBomblets(ctx(projectiles), carrier(null) as Projectile);
    expect(projectiles).toHaveLength(4);
    for (const b of projectiles) {expect(b.shooterId).toBeNull();}
  });
});
