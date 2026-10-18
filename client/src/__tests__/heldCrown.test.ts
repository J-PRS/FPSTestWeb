import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HeldCrown } from '../entities/heldCrown.js';
import { decomposeTokens, tokenTier } from '../../../shared/pickups.js';

// HeldCrown turns a held number into the orbiting denomination pile +
// beam: coin count must match decomposeTokens, beam takes the TOP tier's
// color, and rebuilds only happen on value change — the same set() called
// per frame must be a no-op.
const coinCount = (c: HeldCrown): number => c.group.children.length - 1; // minus the beam

function beamColor(c: HeldCrown): number {
  const beam = c.group.children[0] as THREE.Mesh;
  return (beam.material as THREE.MeshBasicMaterial).color.getHex();
}

describe('HeldCrown', () => {
  it('hides on zero and shows on first held', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(0);
    expect(c.group.visible).toBe(false);
    c.set(10);
    expect(c.group.visible).toBe(true);
  });

  it('decomposes held into one coin per denomination', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(10); // 9 + 1 → blue + white
    expect(coinCount(c)).toBe(2);
    c.set(40); // 27 + 9 + 3 + 1 → one of each
    expect(coinCount(c)).toBe(4);
  });

  it('beam takes the top denomination color', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(30); // contains a 27 → purple beam
    expect(beamColor(c)).toBe(tokenTier(27).color);
    c.set(10); // top is 9 → blue beam
    expect(beamColor(c)).toBe(tokenTier(9).color);
  });

  it('coin scale follows the denomination tier', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(40); // vals order: 27, 9, 3, 1
    const coins = c.group.children.slice(1) as THREE.Group[];
    expect(coins[0]!.scale.x).toBeCloseTo(tokenTier(27).scale);
    expect(coins[3]!.scale.x).toBeCloseTo(tokenTier(1).scale);
  });

  it('same held value does not rebuild the ring', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(10);
    const before = [...c.group.children];
    c.set(10);
    expect(c.group.children).toEqual(before); // identity, not just count
  });

  it('pathological hoards cap the coin count', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(1_000_000); // greedy decompose = 17 coins → capped at 8
    expect(coinCount(c)).toBe(8);
    expect(decomposeTokens(1_000_000).length).toBeGreaterThan(8);
  });

  it('follow parks the ring above the feet, always upright', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(10);
    c.follow(new THREE.Vector3(5, 10, 7), 2.2);
    expect(c.group.position.y).toBeCloseTo(10 + 2.2 + 0.45);
    expect(c.group.rotation.x).toBe(0); // scene-rooted — never inherits body pitch/roll
    expect(c.group.rotation.z).toBe(0);
  });

  it('clearing held hides the crown and empties the ring', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(10);
    c.set(0);
    expect(c.group.visible).toBe(false);
    expect(coinCount(c)).toBe(0);
  });
});
