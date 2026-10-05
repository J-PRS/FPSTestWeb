import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { fogTint } from '../world/directionalFog.js';

const BASE = new THREE.Color(0xbb_d0_e8);
const SUN = new THREE.Vector3(1, 0.4, 0).normalize();
const out = new THREE.Color();

describe('fogTint', () => {
  it('looking at the sun warms the haze', () => {
    fogTint(BASE, new THREE.Vector3(1, 0, 0), SUN, out);
    expect(out.r).toBeGreaterThan(BASE.r);
    expect(out.b).toBeLessThan(BASE.b);
  });

  it('looking away cools the haze', () => {
    fogTint(BASE, new THREE.Vector3(-1, 0, 0), SUN, out);
    expect(out.b).toBeGreaterThan(BASE.b);
    expect(out.r).toBeLessThan(BASE.r);
  });

  it('perpendicular view leaves base nearly unchanged', () => {
    fogTint(BASE, new THREE.Vector3(0, 0, 1), SUN, out);
    expect(out.r).toBeCloseTo(BASE.r, 2);
    expect(out.g).toBeCloseTo(BASE.g, 2);
    expect(out.b).toBeCloseTo(BASE.b, 2);
  });

  it('looking straight up ignores the sun entirely', () => {
    fogTint(BASE, new THREE.Vector3(0, 1, 0), SUN, out);
    expect(out.r).toBeCloseTo(BASE.r, 5);
    expect(out.g).toBeCloseTo(BASE.g, 5);
    expect(out.b).toBeCloseTo(BASE.b, 5);
  });

  it('never mutates the base color', () => {
    const before = BASE.clone();
    fogTint(BASE, new THREE.Vector3(1, 0, 0), SUN, out);
    expect(BASE.equals(before)).toBe(true);
  });
});
