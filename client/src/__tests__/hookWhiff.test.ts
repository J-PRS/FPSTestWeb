/* oxlint-disable typescript/no-explicit-any -- test stubs are deliberately loosely typed */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { processProjectileExplosion } from '../game/combat/projectiles.js';
import type { ExplosionArgs, CombatCtx } from '../game/combat.js';
import { WeaponType } from '../../../shared/weapons.js';

/** A hook dart that expires mid-air must never run the generic pull —
 *  hookConnect (contact-gated) or a wire grapple are the only reel paths.
 *  Before the gate, processProjectileExplosion fed forceMode:'pull' into
 *  applyExplosionForce on a bare fuse pop: whiffed dart, real yank. */
const mkCtx = (): { c: CombatCtx; force: ReturnType<typeof vi.fn> } => {
  const force = vi.fn();
  const player = { pos: new THREE.Vector3(0, 0, 0), mods: { knockbackTaken: 1 } };
  const c = {
    applyExplosionForce: force,
    deps: {
      lazyScene: () => new THREE.Scene(),
      lazyTerrain: () => ({ getHeight: () => -1000 }), // far below — no scorch
      lazyPlayer: () => player,
      lazyCamera: () => null,
      lazyDemoManager: () => null,
      lazyNetworkManager: () => ({ getLocalPlayerId: () => 'me', isConnected: () => true }),
      world: { explosions: [], implosions: [], scorches: [], aoeGizmos: [] },
      explosionTracker: { addExplosion: vi.fn() },
    },
  } as unknown as CombatCtx;
  return { c, force };
};

const args = (over: Partial<ExplosionArgs> = {}): ExplosionArgs => Object.assign(
  { pos: new THREE.Vector3(0, 50, 0), radius: 6, force: 18, forceMode: 'pull' as const, aoeDamage: 0, forceMultiplier: 1 },
  over);

describe('hook whiff — no pull on empty air', (): void => {
  it('a Hook detonation never calls applyExplosionForce', (): void => {
    const { c, force } = mkCtx();
    processProjectileExplosion(c, args({ weaponType: WeaponType.Hook }));
    expect(force).not.toHaveBeenCalled();
  });

  it('a real blast still applies force normally', (): void => {
    const { c, force } = mkCtx();
    processProjectileExplosion(c, args({ weaponType: WeaponType.BoltLauncher, forceMode: 'push' }));
    expect(force).toHaveBeenCalledOnce();
  });
});
