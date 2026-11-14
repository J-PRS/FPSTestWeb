import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { lgTrace } from '../game/combat/lightningTrace.js';
import type { CombatDeps } from '../game/combat.js';

// The Lightning Gun beam latched onto teammates: tracePlayerHit iterated
// every remote with no team filter, while the server's beamSweep defaults
// includeTeammates=false — the authority never pays those hits, so the
// visual bolt attached to a friendly it could never damage. The client
// trace must pass through teammates on BOTH legs (straight + terrain
// bounce), the same doors the server keeps shut.

interface FakeRemote {
  isDead: boolean;
  position: THREE.Vector3;
  armorClass?: string;
  team?: string;
}

const remote = (x: number, y: number, z: number, team?: string): FakeRemote => ({
  isDead: false,
  position: new THREE.Vector3(x, y, z),
  team,
});

function rig(remotes: Map<string, FakeRemote>, opts: {
  localTeam?: string;
  wireTeams?: Record<string, string>;
  ground?: (x: number, z: number) => number;
} = {}): CombatDeps {
  const wireMap = new Map(Object.entries(opts.wireTeams ?? {}).map(([k, team]) => [k, { team }]));
  return {
    world: { remotePlayers: remotes, localTeam: opts.localTeam },
    targets: [],
    lazyTerrain: () => ({ getHeight: opts.ground ?? ((): number => -1e9) }),
    lazyNetworkManager: () => ({ getPlayers: () => wireMap, serverPingMs: 0 }),
  } as unknown as CombatDeps;
}

const cam = (): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  c.position.set(0, 10, 0);
  c.lookAt(0, 10, -50); // beam runs down -z at eye height y=10
  c.updateMatrixWorld(true);
  return c;
};

describe('LG trace teammate pass-through', (): void => {
  it('hits an enemy dead ahead', (): void => {
    const remotes = new Map([['foe', remote(0, 10, -20, 'bravo')]]);
    const r = lgTrace(rig(remotes, { localTeam: 'alpha' }), cam(), { t: 0 });
    expect(r.hitPlayerId).toBe('foe');
    expect(r.hitT).toBeGreaterThan(18);
    expect(r.hitT).toBeLessThan(20);
  });

  it('passes through a teammate on the straight leg', (): void => {
    const remotes = new Map([['pal', remote(0, 10, -20, 'alpha')]]);
    const r = lgTrace(rig(remotes, { localTeam: 'alpha' }), cam(), { t: 0 });
    expect(r.hitPlayerId).toBeNull();
    expect(r.bend).toBeNull();
  });

  it('a teammate never body-blocks the enemy behind him', (): void => {
    const remotes = new Map([
      ['pal', remote(0, 10, -15, 'alpha')],
      ['foe', remote(0, 10, -30, 'bravo')],
    ]);
    const r = lgTrace(rig(remotes, { localTeam: 'alpha' }), cam(), { t: 0 });
    expect(r.hitPlayerId).toBe('foe');
  });

  it('teamless remotes stay hittable (FFA)', (): void => {
    const remotes = new Map([['foe', remote(0, 10, -20)]]);
    const r = lgTrace(rig(remotes, { localTeam: 'alpha' }), cam(), { t: 0 });
    expect(r.hitPlayerId).toBe('foe');
  });

  it('wire team resolves when the replica field is missing', (): void => {
    const remotes = new Map([['pal', remote(0, 10, -20)]]);
    const r = lgTrace(rig(remotes, { localTeam: 'alpha', wireTeams: { pal: 'alpha' } }), cam(), { t: 0 });
    expect(r.hitPlayerId).toBeNull();
  });

  it('the terrain-bounce pick skips teammates too', (): void => {
    // Beam grounds at z≈-13 (cliff face), then must arc to the enemy
    // 6m off the contact — not the teammate standing 1m off it.
    const remotes = new Map([
      ['pal', remote(1.2, 10, -12, 'alpha')],
      ['foe', remote(6, 10, -12.5, 'bravo')],
    ]);
    const r = lgTrace(rig(remotes, {
      localTeam: 'alpha',
      ground: (x: number, z: number): number => 1e9 * Math.sign(-13 - z),
    }), cam(), { t: 0 });
    expect(r.bend).not.toBeNull();
    expect(r.hitPlayerId).toBe('foe');
  });
});
