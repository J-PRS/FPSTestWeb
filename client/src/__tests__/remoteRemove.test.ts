import { describe, expect, it, vi } from 'vitest';
import {createRemotes, type RemotesDeps} from '../game/remotes.js';
import { lastWeaponByPlayer } from '../game/net/projectiles.js';

// onRemove is the client depart funnel for wire players — every
// id-keyed receipt must drain through it or a leaver leaves per-id
// state for the session's life. A new keyed map added without a
// delete here fails this pin instead of leaking silently.
const mkDeps = () => {
  const world = {
    remotePlayers: { hooks: {} as Record<string, unknown> },
    killCounts: new Map<string, number>(),
    deathCounts: new Map<string, number>(),
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
  it('a leaver drops out of lastWeaponByPlayer, HUD and health bars — scores persist', () => {
    const { deps, world, hud, healthbars } = mkDeps();
    createRemotes(deps);
    const onRemove = world.remotePlayers.hooks.onRemove as (id: string) => void;

    world.killCounts.set('leaver', 3);
    world.deathCounts.set('leaver', 2);
    lastWeaponByPlayer.set('leaver', { wt: 1, n: 2 });
    onRemove('leaver');

    // kill/death counts deliberately survive: onRemove also fires on the
    // corpse→respawn entity swap, and zeroing there wiped K/D per respawn.
    expect(world.killCounts.has('leaver')).toBe(true);
    expect(world.deathCounts.has('leaver')).toBe(true);
    expect(lastWeaponByPlayer.has('leaver')).toBe(false);
    expect(hud.removePlayerIndicator).toHaveBeenCalledWith('leaver');
    expect(healthbars.forgetPlayer).toHaveBeenCalledWith('leaver');
  });
});
