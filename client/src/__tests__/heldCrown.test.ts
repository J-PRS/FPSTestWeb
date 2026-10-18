import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HeldCrown } from '../entities/heldCrown.js';
import { decomposeTokens, tokenTier } from '../../../shared/pickups.js';
import { EMIT_GAIN } from '../core/config.js';

// Beam shafts take the lerp-only tier color (no EMIT_GAIN — that's what
// kept them off the lightsaber look); the core/glow ride the boosted emit.
const emitHex = (tierColor: number): number =>
  new THREE.Color(tierColor).lerp(new THREE.Color(0xFF_FF_FF), 0.33).multiplyScalar(EMIT_GAIN).getHex();
const shaftHex = (tierColor: number): number =>
  new THREE.Color(tierColor).lerp(new THREE.Color(0xFF_FF_FF), 0.33).getHex();

// HeldCrown turns a held number into the orbiting denomination pile +
// beam: coin count must match decomposeTokens, beam takes the TOP tier's
// color, and rebuilds only happen on value change — the same set() called
// per frame must be a no-op.
const coinCount = (c: HeldCrown): number => c.group.children.filter((o): boolean => o instanceof THREE.Group).length;
// Coins are Groups; beams are Meshes riding the same group.
const beams = (c: HeldCrown): THREE.Mesh[] => c.group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);

function beamColors(c: HeldCrown): number[] {
  return beams(c).map((b): number => (b.material as THREE.MeshBasicMaterial).color.getHex());
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

  it('every coin gets its own tier-colored beacon', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(30); // 27 + 3 → one purple shaft + one green shaft
    expect(beams(c).length).toBe(2);
    expect(beamColors(c)).toEqual([shaftHex(tokenTier(27).color), shaftHex(tokenTier(3).color)]);
  });

  it('two purples count as two purples — total value, not top tier', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(54); // 27 + 27 → two purple coins, not one
    expect(coinCount(c)).toBe(2);
    const coins = c.group.children.filter((o): boolean => o instanceof THREE.Group) as THREE.Group[];
    expect(coins.every((m) => m.scale.x === tokenTier(27).scale)).toBe(true);
    expect(beamColors(c)).toEqual([shaftHex(tokenTier(27).color), shaftHex(tokenTier(27).color)]);
  });

  it('coin scale follows the denomination tier', () => {
    const scene = new THREE.Scene();
    const c = new HeldCrown(scene);
    c.set(40); // vals order: 27, 9, 3, 1
    const coins = c.group.children.filter((o): boolean => o instanceof THREE.Group) as THREE.Group[];
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
