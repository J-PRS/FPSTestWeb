/**
 * Conquest node damage: applyBlast must actually burn frontier enemy
 * nodes down, refuse ghosted (out-of-chain) and friendly nodes, and the
 * hitbox path (direct fire → applyBlast) must reach the same gate.
 */
import { describe, expect, it } from 'bun:test';
import { ConquestSim, type ConquestHost } from '../../shared/conquestSim.ts';

function host(teamOf: (id: string | undefined) => 'alpha' | 'bravo' | undefined = () => 'alpha'): ConquestHost {
  return {
    groundAt: () => 0,
    bodies: function* (): Iterable<never> {},
    teamOf,
    emitNodes: () => {},
    setScores: () => {},
  };
}

function mkSim(): ConquestSim {
  return new ConquestSim(host(), 300);
}

describe('Conquest node damage', () => {
  it('blast on an enemy frontier node burns hp toward neutral', () => {
    const s = mkSim();
    // Claim the core's neighbor as the enemy's so it's actionable for alpha.
    const enemy = s.nodes.find((n): boolean => !n.core && n.owner === 'neutral')!;
    enemy.owner = 'bravo';
    const before = enemy.hp;
    s.applyBlast({ x: enemy.pos.x, y: enemy.pos.y, z: enemy.pos.z }, 200, 5, 'shooter');
    expect(enemy.hp).toBeLessThan(before);
  });

  it('enough blast neutralizes a frontier node', () => {
    const s = mkSim();
    const enemy = s.nodes.find((n): boolean => !n.core && n.owner === 'neutral')!;
    enemy.owner = 'bravo';
    for (let i = 0; i < 10; i += 1) {
      s.applyBlast({ x: enemy.pos.x, y: enemy.pos.y, z: enemy.pos.z }, 200, 5, 'shooter');
    }
    expect(enemy.owner as string).toBe('neutral');
  });

  it('ghosted nodes (out of frontier) eat the blast but take no damage', () => {
    const s = mkSim();
    // A node far from alpha's core chain: not 4-adjacent to any alpha node.
    const far = s.nodes[s.nodes.length - 1]!;
    far.owner = 'bravo';
    const before = far.hp;
    s.applyBlast({ x: far.pos.x, y: far.pos.y, z: far.pos.z }, 200, 5, 'shooter');
    // Only non-frontier for alpha if not adjacent to an alpha-owned cell.
    // Corner cores are alpha (0,0) and bravo (n-1,n-1); last node is the
    // bravo core's region, so it's actionable for bravo, not alpha.
    expect(far.hp).toBe(before);
  });

  it('friendly-owned nodes are immune to friendly fire', () => {
    const s = mkSim();
    const mine = s.nodes.find((n): boolean => n.owner === 'alpha')!;
    const before = mine.hp;
    s.applyBlast({ x: mine.pos.x, y: mine.pos.y, z: mine.pos.z }, 200, 5, 'shooter');
    expect(mine.hp).toBe(before);
  });

  it("the 'local' player id resolves through teamOf and damages the frontier", () => {
    const s = new ConquestSim(host((id) => (id === 'local' ? 'alpha' : undefined)), 300);
    const enemy = s.nodes.find((n): boolean => !n.core && n.owner === 'neutral')!;
    enemy.owner = 'bravo';
    const before = enemy.hp;
    s.applyBlast({ x: enemy.pos.x, y: enemy.pos.y, z: enemy.pos.z }, 200, 5, 'local');
    expect(enemy.hp).toBeLessThan(before);
  });

  it('a bot id resolves the same way - bots can siege the frontier too', () => {
    // Bot fires for bravo against an alpha-owned node on BRAVO's frontier
    // (4-adjacent to the bravo core at the far corner).
    const s = new ConquestSim(host((id) => (id === 'bot_7' ? 'bravo' : id === 'local' ? 'alpha' : undefined)), 300);
    const core = s.nodes.find((n): boolean => n.core && n.owner === 'bravo')!;
    const enemy = s.nodes.find((n): boolean => Math.abs(n.gx - core.gx) + Math.abs(n.gz - core.gz) === 1)!;
    enemy.owner = 'alpha';
    const before = enemy.hp;
    s.applyBlast({ x: enemy.pos.x, y: enemy.pos.y, z: enemy.pos.z }, 200, 5, 'bot_7');
    expect(enemy.hp).toBeLessThan(before);
  });

  it('unknown shooters do nothing (teamOf gate)', () => {
    const s = new ConquestSim(host(() => undefined), 300);
    const enemy = s.nodes.find((n): boolean => !n.core && n.owner === 'neutral')!;
    enemy.owner = 'bravo';
    const before = enemy.hp;
    s.applyBlast({ x: enemy.pos.x, y: enemy.pos.y, z: enemy.pos.z }, 200, 5, 'mystery');
    expect(enemy.hp).toBe(before);
  });
});
