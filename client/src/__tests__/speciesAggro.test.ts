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
  lazyTerrain: () => ({ getHeight: () => 0 }),
  world: { remotePlayers: remotes },
} as unknown as EntitiesDeps);

const remote = (over: Record<string, unknown> = {}) => ((((Object.assign({}, {pos: new THREE.Vector3(5, 0, 0),vel: new THREE.Vector3(),isDead: false,lastUpdateTime: Date.now()}, over)))));

describe('AggroKit candidate roster', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('local player is always a candidate unless dead/cloaked/spectating', () => {
    const p = stubPlayer();
    const kit = new AggroKit(stubDeps(new Map(), p), [], () => null);
    const cands = kit.candidates();
    expect(cands.some(c => c.id === 'local')).toBe(true);
    p.isDead = true;
    // Roster memoizes per 16ms performance frame — force the next eval.
    kit._candFrame = -1;
    expect(kit.candidates().find(c => c.id === 'local')!.alive).toBe(false);
  });

  it('stale remotes stop being targets after 2s without updates', () => {
    const remotes = new Map<string, unknown>([['r1', remote()]]);
    const kit = new AggroKit(stubDeps(remotes), [], () => null);
    expect(kit.candidates().find(c => c.id === 'r1')!.alive).toBe(true);
    vi.advanceTimersByTime(2100);
    expect(kit.candidates().find(c => c.id === 'r1')!.alive).toBe(false);
  });

  it('localDriven remotes (offline bots) never go stale', () => {
    const remotes = new Map<string, unknown>([['bot', remote({ localDriven: true, lastUpdateTime: 0 })]]);
    const kit = new AggroKit(stubDeps(remotes), [], () => null);
    vi.advanceTimersByTime(60_000);
    expect(kit.candidates().find(c => c.id === 'bot')!.alive).toBe(true);
  });

  it('departed remotes are pruned from the roster', () => {
    const remotes = new Map<string, unknown>([['r1', remote()]]);
    const kit = new AggroKit(stubDeps(remotes), [], () => null);
    kit.candidates();
    remotes.delete('r1');
    kit._candFrame = -1;
    expect(kit.candidates().some(c => c.id === 'r1')).toBe(false);
  });

  it('deployables join the candidate list as chewable scenery', () => {
    const depCand = { id: 'turret', pos: new THREE.Vector3(9, 0, 0), vel: new THREE.Vector3(), alive: true };
    const kit = new AggroKit(stubDeps(), [], () => ({ candidates: () => [depCand], hurt: () => { return; } }));
    expect(kit.candidates().some(c => c.id === 'turret')).toBe(true);
  });
});
