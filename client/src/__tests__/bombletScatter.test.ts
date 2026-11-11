/* oxlint-disable typescript/no-explicit-any -- minimal Projectile/ctx stubs */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { spawnClusterBomblets } from '../game/combat/impact.js';
import type { CombatCtx } from '../game/combat.js';
import { simRngSeed } from '../../../shared/simRand.js';

// PBT on the bomblet scatter - impact.ts:545-590 was 95% untested and
// the surviving mutants were all arithmetic inside the uniform-sphere
// sampling. The pin is statistical: direction distribution + kick band.

const carrier = (vel: THREE.Vector3): any => ({
  config: { cluster: { count: 300, spread: 0, fuse: 0, sphere: true }, bomblet: undefined, speed: 0, inherit: 0 },
  hitPointValid: false,
  pos: new THREE.Vector3(0, 50, 0),
  vel,
  shooterId: 'p9',
});

const ctx = (projectiles: any[]): CombatCtx => ({
  deps: {
    lazyScene: (): THREE.Scene => new THREE.Scene(),
    world: { projectiles },
  },
}) as unknown as CombatCtx;

describe('bomblet scatter - uniform sphere law', (): void => {
  it('directions cover the sphere uniformly and kicks stay in the 6-18 band', (): void => {
    simRngSeed(0xB00B);
    const projectiles: any[] = [];
    const carrierVel = new THREE.Vector3(20, -5, 10);
    spawnClusterBomblets(ctx(projectiles), carrier(carrierVel));
    expect(projectiles).toHaveLength(300);
    let sumU = 0, sumU2 = 0;
    for (const b of projectiles) {
      // Recover the random kick: ctor applies config.inherit (0.5) to
      // _bombVel = (carrier + dir*kick)*2, so vel = carrier + dir*kick.
      const kick = b.vel.clone().sub(carrierVel);
      const kickLen = kick.length();
      expect(kickLen).toBeGreaterThanOrEqual(6);
      expect(kickLen).toBeLessThanOrEqual(18);
      const u = kick.y / kickLen; // uniform-sphere z coordinate
      expect(u).toBeGreaterThanOrEqual(-1);
      expect(u).toBeLessThanOrEqual(1);
      sumU += u;
      sumU2 += u * u;
    }
    // Uniform on sphere: E[u]=0, E[u^2]=1/3. 300 samples, wide bands.
    expect(Math.abs(sumU / 300)).toBeLessThan(0.15);
    expect(sumU2 / 300).toBeGreaterThan(0.25);
    expect(sumU2 / 300).toBeLessThan(0.42);
  });
});
