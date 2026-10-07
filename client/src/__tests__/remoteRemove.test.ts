import { describe, expect, it, vi } from 'vitest';
import { createRemotes } from '../game/remotes.js';
import { lastWeaponByPlayer } from '../game/net/projectiles.js';
import type { RemotesDeps } from '../game/remotes.js';

// onRemove is the client depart funnel for wire players — every
// id-keyed receipt must drain through it or a leaver leaves per-id
// state for the session's life. A new keyed map added without a
// delete here fails this pin instead of leaking silently.
const mkDeps = () => {
  const world = {
    remotePlayers: { hooks: {} as Record<string, unknown> },
    killCounts: new Map<string, number>(),
  };
  const hud = { removePlayerIndicator: vi.fn() };
  const healthbars = { forgetPlayer: vi.fn() };
  const deps = {
    world,
    lazyHud: () => hud,
    lazyHealthBarSystem: () => healthbars,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    lazyNetworkManager: () => ({}),
    lazyScene: () => ({}),
    lazyTerrain: () => ({}),
    lazyCamera: () => ({}),
    lazyPlayer: () => ({}),
    lazyEffects: () => ({}),
  } as unknown as RemotesDeps;
  return { deps, world, hud, healthbars };
};

describe('remote onRemove purges per-player receipts', () => {
  it('a leaver drops out of killCounts, lastWeaponByPlayer, HUD and health bars', () => {
    const { deps, world, hud, healthbars } = mkDeps();
    createRemotes(deps);
    const onRemove = world.remotePlayers.hooks.onRemove as (id: string) => void;

    world.killCounts.set('leaver', 3);
    lastWeaponByPlayer.set('leaver', { wt: 1, n: 2 });
    onRemove('leaver');

    expect(world.killCounts.has('leaver')).toBe(false);
    expect(lastWeaponByPlayer.has('leaver')).toBe(false);
    expect(hud.removePlayerIndicator).toHaveBeenCalledWith('leaver');
    expect(healthbars.forgetPlayer).toHaveBeenCalledWith('leaver');
  });
});
