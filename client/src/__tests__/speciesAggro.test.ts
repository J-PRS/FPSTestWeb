import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

import { AggroKit } from '../game/speciesAggro.js';
import type { EntitiesDeps } from '../game/entities.js';

// AggroKit only reads lazyPlayer/lazyTerrain/world off deps — the rest of
// the surface is unused by the targeting layer.
export const stubPlayer = () => ({
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  isDead: false,
  isCloaked: false,
  isSpectating: false,
});
const stubDeps = (remotes = new Map<string, unknown>(), player = stubPlayer()): EntitiesDeps => ({
  lazyPlayer: () => player,
  lazyTerrain: (): { getHeight: () => number; } => ({ getHeight: (): number => 0 }),
  world: { remotePlayers: remotes },
} as unknown as EntitiesDeps);

const remote = (over: Record<string, unknown> = {}) => ((((Object.assign({}, {pos: new THREE.Vector3(5, 0, 0),vel: new THREE.Vector3(),isDead: false,lastUpdateTime: Date.now()}, over)))));

describe('AggroKit candidate roster', (): void => {
  beforeEach((): void => { vi.useFakeTimers(); });
  afterEach((): void => { vi.useRealTimers(); });

  it('local player is always a candidate unless dead/cloaked/spectating', (): void => {
    const p = stubPlayer();
    const kit = new AggroKit(stubDeps(new Map(), p), [], (): null => null);
    const cands = kit.candidates();
    expect(cands.some((c): boolean => c.id === 'local')).toBe(true);
    p.isDead = true;
    // Roster memoizes per 16ms performance frame — force the next eval.
    kit._candFrame = -1;
    expect(kit.candidates().find((c): boolean => c.id === 'local')!.alive).toBe(false);
  });

  it('stale remotes stop being targets after 2s without updates', (): void => {
    const remotes = new Map<string, unknown>([['r1', remote()]]);
    const kit = new AggroKit(stubDeps(remotes), [], (): null => null);
    expect(kit.candidates().find((c): boolean => c.id === 'r1')!.alive).toBe(true);
    vi.advanceTimersByTime(2100);
    expect(kit.candidates().find((c): boolean => c.id === 'r1')!.alive).toBe(false);
  });

  it('localDriven remotes (offline bots) never go stale', (): void => {
    const remotes = new Map<string, unknown>([['bot', remote({ localDriven: true, lastUpdateTime: 0 })]]);
    const kit = new AggroKit(stubDeps(remotes), [], (): null => null);
    vi.advanceTimersByTime(60_000);
    expect(kit.candidates().find((c): boolean => c.id === 'bot')!.alive).toBe(true);
  });

  it('departed remotes are pruned from the roster', (): void => {
    const remotes = new Map<string, unknown>([['r1', remote()]]);
    const kit = new AggroKit(stubDeps(remotes), [], (): null => null);
    kit.candidates();
    remotes.delete('r1');
    kit._candFrame = -1;
    expect(kit.candidates().some((c): boolean => c.id === 'r1')).toBe(false);
  });

  it('deployables join the candidate list as chewable scenery', (): void => {
    const depCand = { id: 'turret', pos: new THREE.Vector3(9, 0, 0), vel: new THREE.Vector3(), alive: true };
    const kit = new AggroKit(stubDeps(), [], () => ({ candidates: (): { id: string; pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean; }[] => [depCand], hurt: (): void => { return; } }));
    expect(kit.candidates().some((c): boolean => c.id === 'turret')).toBe(true);
  });
});
