import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyWaterSurface, getWaterLevel } from '../world/waterSurface.js';
import { waterSplashAt } from '../effects/waterSplash.js';
import type { Terrain } from '../world/terrain.js';

// Gating only — blastBurst itself no-ops headless (vfx never init'ed).
const belowWater = { getHeight: (): number => 5 } as unknown as Terrain;   // seabed
const aboveWater = { getHeight: (): number => 30 } as unknown as Terrain;  // beach
const at = (y: number): THREE.Vector3 => new THREE.Vector3(10, y, -20);

describe('waterSplashAt', (): void => {
  it('splashes only near the live sea level, only over water', (): void => {
    const scene = new THREE.Scene();
    applyWaterSurface(scene, { level: 12 });
    expect(getWaterLevel()).toBe(12);

    expect(waterSplashAt(at(12.5), 1, belowWater)).toBe(true);  // at the surface
    expect(waterSplashAt(at(9), 1, belowWater)).toBe(true);     // shell fused on seabed
    expect(waterSplashAt(at(60), 1, belowWater)).toBe(false);   // air blast far above
    expect(waterSplashAt(at(12.5), 1, aboveWater)).toBe(false); // over the beach
    expect(waterSplashAt(at(12.5), 1)).toBe(true);              // no terrain = assume wet
  });

  it('is a no-op on a dry map', (): void => {
    const scene = new THREE.Scene();
    applyWaterSurface(scene, undefined);
    expect(getWaterLevel()).toBeUndefined();
    expect(waterSplashAt(at(12), 10, belowWater)).toBe(false);
  });
});
