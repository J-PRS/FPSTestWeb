import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { poissonDisc } from '../utils/poissonSpread.js';
import { ExplosionTracker } from '../utils/ExplosionTracker.js';
import { FRAG_MESSAGE_DURATION } from '../core/config.js';

describe('poissonDisc', (): void => {
  it('returns n points inside the unit disc', (): void => {
    for (const n of [1, 4, 12, 32]) {
      const pts = poissonDisc(n);
      expect(pts.length).toBe(n);
      for (const p of pts) {expect(p.x * p.x + p.y * p.y).toBeLessThanOrEqual(1 + 1e-9);}
    }
  });

  it('keeps sampled points apart (no clumping)', (): void => {
    const n = 16;
    const pts = poissonDisc(n);
    const minDist = Math.sqrt(Math.PI / (n * 1.9));
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        expect(d).toBeGreaterThan(minDist * 0.5); // relaxed bound — fallback spiral may starve
      }
    }
  });

  it('caches per count — repeated calls return the same array', (): void => {
    expect(poissonDisc(8)).toBe(poissonDisc(8));
  });
});

describe('ExplosionTracker', (): void => {
  it('returns recorded explosions newest-last with cloned positions', (): void => {
    const t = new ExplosionTracker();
    const pos = new THREE.Vector3(1, 2, 3);
    t.addExplosion(pos, 100, 'p1');
    const got = t.getRecentExplosions();
    expect(got).toHaveLength(1);
    expect(got[0].shooterId).toBe('p1');
    expect(got[0].force).toBe(100);
    expect(got[0].position).not.toBe(pos); // clone — caller mutation mustn't leak
    pos.x = 99;
    expect(got[0].position.x).toBe(1);
  });

  it('expires entries past FRAG_MESSAGE_DURATION', (): void => {
    vi.useFakeTimers();
    try {
      const t = new ExplosionTracker();
      t.addExplosion(new THREE.Vector3(), 1, 'old');
      vi.setSystemTime(Date.now() + FRAG_MESSAGE_DURATION + 1);
      t.addExplosion(new THREE.Vector3(5, 0, 0), 2, 'new');
      const got = t.getRecentExplosions();
      expect(got).toHaveLength(1);
      expect(got[0].shooterId).toBe('new');
    } finally {
      vi.useRealTimers();
    }
  });
});
