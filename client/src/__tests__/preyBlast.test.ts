import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createBlastForce } from '../game/blastForce.js';
import type { CombatDeps } from '../game/combat.js';
import { KNOCKBACK_SCALE, aoeImpulse } from '../../../shared/combat.js';

// applyForceToPrey is the remote-blast shove on replayed prey sims
// (balls + nuggets): the server's 'prey' knock event applies a flat,
// UNCAPPED dir*force envelope with no occlusion check. The prediction
// must mirror that exactly — a player-feel cap (BLAST_IMPULSE_MAX=30
// while knockbackForce reaches 45) or a LOS gate is a rubberband on
// every heavy blast near a swarm.

interface FakeBall {
  dead: boolean;
  pos: THREE.Vector3;
  radius: number;
  imp: THREE.Vector3;
  applyKnockback(from: THREE.Vector3, force: number): void;
  applyPull(to: THREE.Vector3, force: number): void;
}

const fakeBall = (x: number, y: number, z: number, radius = 1): FakeBall => ({
  dead: false,
  pos: new THREE.Vector3(x, y, z),
  radius,
  imp: new THREE.Vector3(),
  applyKnockback(from: THREE.Vector3, force: number): void {
    // Ball.applyKnockback's own math: flat dir*force, no falloff —
    // identical to the server sim's knock().
    this.imp.copy(this.pos).sub(from).normalize().multiplyScalar(force);
  },
  applyPull(to: THREE.Vector3, force: number): void {
    this.imp.copy(to).sub(this.pos).normalize().multiplyScalar(force);
  },
});

function rig(balls: FakeBall[], nuggets: { dead: boolean; collected: boolean; pos: THREE.Vector3; imp: THREE.Vector3 }[] = []) {
  for (const n of nuggets) {
    (n as unknown as Record<string, unknown>)['applyKnockback'] = (from: THREE.Vector3, f: number): void => { n.imp.copy(n.pos).sub(from).normalize().multiplyScalar(f); };
    (n as unknown as Record<string, unknown>)['applyPull'] = (to: THREE.Vector3, f: number): void => { n.imp.copy(to).sub(n.pos).normalize().multiplyScalar(f); };
  }
  const deps = { targets: balls, nuggets } as unknown as CombatDeps;
  return createBlastForce(deps, { onTargetDestroyed: (): void => {} });
}

describe('applyForceToPrey — remote-blast knock mirrors server prey knock', (): void => {
  const blast = new THREE.Vector3(0, 0, 0);

  it('pushes a ball inside the envelope with the full uncapped impulse', (): void => {
    const b = fakeBall(10, 0, 0);
    const { applyForceToPrey } = rig([b]);
    applyForceToPrey(blast, 30, 45, 'push');
    // Server: b.v += (dx/d)*force — flat 45, not the 30 player-feel cap.
    expect(b.imp.x).toBeCloseTo(45 * KNOCKBACK_SCALE, 4);
    expect(b.imp.y).toBeCloseTo(0, 6);
    expect(b.imp.z).toBeCloseTo(0, 6);
  });

  it('ignores occlusion — the server knock is distance-envelope only', (): void => {
    const b = fakeBall(10, 0, 0);
    const { applyForceToPrey } = rig([b]);
    applyForceToPrey(blast, 30, 40, 'push');
    expect(b.imp.length()).toBeGreaterThan(0); // fired even with no LOS setup
  });

  it('respects the radius+body envelope edge', (): void => {
    const inside = fakeBall(31, 0, 0); // d=31, radius 30 + body 1 → in
    const outside = fakeBall(31.5, 0, 0); // d=31.5 → out
    const { applyForceToPrey } = rig([inside, outside]);
    applyForceToPrey(blast, 30, 40, 'push');
    expect(inside.imp.length()).toBeGreaterThan(0);
    expect(outside.imp.length()).toBe(0);
  });

  it('skips dead balls', (): void => {
    const b = fakeBall(10, 0, 0);
    b.dead = true;
    const { applyForceToPrey } = rig([b]);
    applyForceToPrey(blast, 30, 40, 'push');
    expect(b.imp.length()).toBe(0);
  });

  it('pull mode flips the impulse direction', (): void => {
    const b = fakeBall(10, 0, 0);
    const { applyForceToPrey } = rig([b]);
    applyForceToPrey(blast, 30, 40, 'pull');
    expect(b.imp.x).toBeLessThan(0);
  });

  it('nuggets take aoeImpulse falloff × 0.4 — same as server pickup knock', (): void => {
    const nug = { dead: false, collected: false, pos: new THREE.Vector3(15, 0, 0), imp: new THREE.Vector3() };
    const { applyForceToPrey } = rig([], [nug]);
    applyForceToPrey(blast, 30, 40, 'push');
    const expected = aoeImpulse(40 * KNOCKBACK_SCALE, 15, 30) * 0.4;
    expect(nug.imp.x).toBeCloseTo(expected, 4);
  });
});
