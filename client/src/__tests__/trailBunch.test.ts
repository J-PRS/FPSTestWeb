/* Sim-flight audit of the missile trail emitter: drives a REAL QuarksTrail
 * on a REAL batcher through a full rocket flight, snapshots every live
 * particle's world position per frame, and measures actual spatial
 * bunching - the screenshot's blown-out beads are either legit spacing or
 * a deposit path dumping many particles into one spot. */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

// impactMat()/normalMat() bake canvas textures - jsdom has no 2d context.
// The texture is render-only; particle math doesn't touch it.
vi.mock('../effects/glowTexture.js', () => ({
  getGlowTexture: (): THREE.Texture => new THREE.Texture(),
  getPuffTexture: (): THREE.Texture => new THREE.Texture(),
}));

import { initVfx, updateVfx } from '../effects/vfxRuntime.js';
import { QuarksTrail } from '../effects/vfx.js';
import { RKT_CONFIG } from '../projectiles/rocketLauncherConfig.js';

describe('missile trail particle bunching - sim flight', (): void => {
  it('no spot on the flight line piles particles beyond expected spacing', (): void => {
    const scene = new THREE.Scene();
    initVfx(scene);

    const pos = new THREE.Vector3(0, 30, 0);
    const vel = new THREE.Vector3(0, 0, 45); // missile speed ≈45 m/s flat
    let age = 0;
    const trail = new QuarksTrail({
      config: RKT_CONFIG, pos, vel,
      age: (): number => age,
    });
    expect((trail as unknown as { ps: unknown }).ps).toBeTruthy();

    const dt = 1 / 60;
    const FRAME_N = Math.ceil(3.2 / dt); // ~3.2s flight (maxLife reach)
    // Per frame: live particle count + max particles inside a 0.6m sphere.
    const stats: { t: number; n: number; maxClump: number; clumpAt: THREE.Vector3 | null; minDist: number }[] = [];
    const {ps} = (trail as unknown as { ps: { particles: { position: THREE.Vector3; life?: number; age?: number; died?: boolean }[]; particleNum: number } });

    for (let f = 0; f < FRAME_N; f += 1) {
      age += dt;
      pos.addScaledVector(vel, dt);
      trail.emitSegment(dt);
      updateVfx(dt, pos);

      // Gather live positions - quarks keeps dead slots in the array;
      // died-flag/life-age gates live ones (shape varies by version, so
      // just take the first particleNum live slots via _particles if needed).
      const pts: THREE.Vector3[] = [];
      const arr = (ps as unknown as { particles: { position: THREE.Vector3 }[] }).particles;
      for (const p of arr) {if (p.position) {pts.push(p.position);}}

      // Brute-force clump census - few hundred particles, cheap.
      let maxClump = 0; let clumpAt: THREE.Vector3 | null = null;
      let minDist = Infinity;
      for (let i = 0; i < pts.length; i += 1) {
        let c = 0;
        for (let j = 0; j < pts.length; j += 1) {
          const d2 = pts[i]!.distanceToSquared(pts[j]!);
          if (j !== i && d2 < minDist) {minDist = d2;}
          if (d2 < 0.36) {c += 1;}
        }
        if (c > maxClump) {maxClump = c; clumpAt = pts[i]!.clone();}
      }
      stats.push({ t: age, n: pts.length, maxClump, clumpAt, minDist: Number.isFinite(minDist) ? Math.sqrt(minDist) : -1 });
    }

    const peakN = Math.max(...stats.map((s): number => s.n));
    const peakClump = Math.max(...stats.map((s): number => s.maxClump));
    const worst = stats.reduce((a, b): typeof a => (b.maxClump > a.maxClump ? b : a));
    // Also: biggest count inside the launch ring during ramp-in - the
    // suspected "everything at one point" window.
    const early = stats.slice(0, Math.ceil(0.15 / dt));
    const earlyClump = early.length > 0 ? Math.max(...early.map((s): number => s.maxClump)) : 0;
    const globalMin = Math.min(...stats.filter((s): boolean => s.minDist > 0).map((s): number => s.minDist));
    expect.soft(peakN, `live=${peakN} clump=${peakClump} early=${earlyClump} worst@t=${worst.t.toFixed(2)} minPair=${globalMin.toFixed(3)}m`).toBeGreaterThan(0);

    // ppu=4/m ⇒ one particle per 0.25m ⇒ ~3 inside any 0.6m sphere at
    // steady state; a deposit bug shows as tens stacked.
    expect(peakN).toBeGreaterThan(10); // trail actually emitted
    expect(peakClump).toBeLessThan(25); // ~12 legit at 8/m density; a bug shows tens
    // Golden-angle scatter guarantee: no coincident duplicates - a
    // same-spot pair is a doubled additive quad (the bright-bead bug).
    // >5mm allows legit tight spacing at high ppu.
    expect(globalMin).toBeGreaterThan(0.005);
  });
});
