import { describe, it, expect } from 'bun:test';
import {
  HEAVY_ONLY_WEAPONS, MEDIUM_ONLY_WEAPONS, LIGHT_ONLY_WEAPONS,
  minClassForWeapon, classCanFire, classCapsule, classMass,
  CLASS_STATS, CLASS_MODEL_SCALE,
} from '../../shared/botClasses.ts';
import { MOVEMENT_CONFIG, GRAVITY } from '../../shared/movement.ts';

// The armor-class contract: tier weapon locks are the server boundary in
// CombatHandler, and the class stats feed the shared sim (mass divides
// jet thrust and knockback) — a number that drifts here desyncs every
// body. Pin the gate semantics and the stats' physics invariants.

describe('botClasses', () => {
  it('tier locks: light+medium are EXACT-class, heavy is a floor', () => {
    // Light-only finesse gear flies only on the frame that paid for it.
    for (const w of LIGHT_ONLY_WEAPONS) {
      expect(classCanFire('light', w)).toBe(true);
      expect(classCanFire('medium', w)).toBe(false);
      expect(classCanFire('heavy', w)).toBe(false);
    }
    for (const w of MEDIUM_ONLY_WEAPONS) {
      expect(classCanFire('light', w)).toBe(false);
      expect(classCanFire('medium', w)).toBe(true);
      expect(classCanFire('heavy', w)).toBe(false); // heavies trade it for ordnance
    }
    for (const w of HEAVY_ONLY_WEAPONS) {
      expect(classCanFire('light', w)).toBe(false);
      expect(classCanFire('medium', w)).toBe(false);
      expect(classCanFire('heavy', w)).toBe(true);
    }
    // Unrestricted slug (Pistol=16) rides every frame.
    expect(classCanFire('light', 16)).toBe(true);
    expect(classCanFire('medium', 16)).toBe(true);
    expect(classCanFire('heavy', 16)).toBe(true);
  });

  it('unknown class defaults to medium — same default the plumbing assumes', () => {
    expect(classCanFire(undefined, 16)).toBe(true);
    expect(classCanFire('goblin', 16)).toBe(true);
    expect(classCanFire(undefined, [...MEDIUM_ONLY_WEAPONS][0]!)).toBe(true);
    expect(classCanFire(undefined, [...HEAVY_ONLY_WEAPONS][0]!)).toBe(false);
    expect(classMass(undefined)).toBe(1);
    expect(classMass('goblin')).toBe(1);
    expect(classCapsule('goblin').eye).toBe(CLASS_STATS.medium.eyeHeight);
  });

  it('minClassForWeapon: light-only reports light — the floor IS the ceiling', () => {
    for (const w of LIGHT_ONLY_WEAPONS) expect(minClassForWeapon(w)).toBe('light');
    for (const w of MEDIUM_ONLY_WEAPONS) expect(minClassForWeapon(w)).toBe('medium');
    for (const w of HEAVY_ONLY_WEAPONS) expect(minClassForWeapon(w)).toBe('heavy');
    expect(minClassForWeapon(16)).toBe('light');
  });

  it('every tier mass stays under the jet-lift ceiling — the pack can always lift the chassis', () => {
    // accel = jetForceUp/mass must beat gravity or a heavy parks forever.
    const ceiling = MOVEMENT_CONFIG.jetForceUp / Math.abs(GRAVITY);
    for (const cls of ['light', 'medium', 'heavy'] as const) {
      expect(CLASS_STATS[cls].mass, cls).toBeLessThan(ceiling);
    }
  });

  it('tier spread: health/radius/mass rise, speed falls, light-to-heavy', () => {
    const { light: l, medium: m, heavy: h } = CLASS_STATS;
    expect(l.maxHealth).toBeLessThan(m.maxHealth);
    expect(m.maxHealth).toBeLessThan(h.maxHealth);
    expect(l.speedScale).toBeGreaterThan(m.speedScale);
    expect(m.speedScale).toBeGreaterThan(h.speedScale);
    expect(l.radius).toBeLessThan(m.radius);
    expect(m.radius).toBeLessThan(h.radius);
    expect(l.mass).toBeLessThanOrEqual(m.mass);
    expect(m.mass).toBeLessThanOrEqual(h.mass);
    expect(l.eyeHeight).toBeLessThanOrEqual(m.eyeHeight);
    expect(m.eyeHeight).toBeLessThanOrEqual(h.eyeHeight);
  });

  it('classCapsule: center sits below the eye, half-height non-negative, class radius', () => {
    for (const cls of ['light', 'medium', 'heavy'] as const) {
      const c = classCapsule(cls);
      const st = CLASS_STATS[cls];
      expect(c.eye).toBe(st.eyeHeight);
      expect(c.height).toBeGreaterThan(st.eyeHeight); // headroom above the eye
      expect(c.centerOff).toBeLessThan(0);            // axis midpoint below the eyes
      expect(c.half).toBeGreaterThanOrEqual(0);
      expect(c.radius).toBe(st.radius);
    }
  });

  it('model scale stays consistent with eye heights — the silhouette is not a lie', () => {
    for (const cls of ['light', 'medium', 'heavy'] as const) {
      // Rendered eye ≈ 1.8*scale must track the capsule's eyeHeight.
      expect(CLASS_MODEL_SCALE[cls] * 1.8).toBeCloseTo(CLASS_STATS[cls].eyeHeight, 5);
    }
  });
});
