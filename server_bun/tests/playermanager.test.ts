import { describe, it, expect } from 'bun:test';
import { PlayerManager } from '../src/PlayerManager.ts';

describe('PlayerManager', () => {
  it('adds a player', () => {
    const pm = new PlayerManager();
    const player = pm.addPlayer('alice'); pm.breakShield('alice');
    expect(player.id).toBe('alice');
    expect(player.health).toBe(100);
    expect(player.isDead).toBe(false);
    expect(pm.getPlayerCount()).toBe(1);
  });

  it('removes a player', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    const removed = pm.removePlayer('alice');
    expect(removed?.id).toBe('alice');
    expect(pm.getPlayerCount()).toBe(0);
  });

  it('applies damage correctly', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    const result = pm.applyDamage('alice', 30);
    expect(result.killed).toBe(false);
    expect(result.newHealth).toBe(70);
  });

  it('kills player when health reaches 0', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    const result = pm.applyDamage('alice', 100);
    expect(result.killed).toBe(true);
    expect(result.newHealth).toBe(0);
    const player = pm.getPlayer('alice');
    expect(player?.isDead).toBe(true);
  });

  it('spawn shield blocks damage until it expires or is broken', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice');
    expect(pm.applyDamage('alice', 30).newHealth).toBe(100); // shielded
    pm.breakShield('alice');
    expect(pm.applyDamage('alice', 30).newHealth).toBe(70);
    // Respawn re-arms the shield
    pm.applyDamage('alice', 100);
    pm.respawnPlayer('alice');
    expect(pm.applyDamage('alice', 30).newHealth).toBe(100);
  });

  it('does not damage dead players', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    pm.applyDamage('alice', 100);
    const result = pm.applyDamage('alice', 50);
    expect(result.killed).toBe(false);
  });

  it('respawns a dead player', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    pm.applyDamage('alice', 100);
    const result = pm.respawnPlayer('alice');
    expect(result).not.toBeNull();
    const player = pm.getPlayer('alice');
    expect(player?.isDead).toBe(false);
    expect(player?.health).toBe(100);
  });

  it('tracks kills', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    pm.addPlayer('bob'); pm.breakShield('bob');
    pm.applyDamage('bob', 100);
    pm.addKill('alice');
    expect(pm.getPlayer('alice')?.kills).toBe(1);
    expect(pm.getPlayer('bob')?.deaths).toBe(1);
  });

  it('gets other players', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    pm.addPlayer('bob'); pm.breakShield('bob');
    pm.addPlayer('carol');
    const others = pm.getOtherPlayers('alice');
    expect(others.length).toBe(2);
    expect(others.some((p) => p.id === 'bob')).toBe(true);
    expect(others.some((p) => p.id === 'carol')).toBe(true);
  });

  it('returns null for respawn of non-existent player', () => {
    const pm = new PlayerManager();
    expect(pm.respawnPlayer('nobody')).toBeNull();
  });

  it('team members spawn near their own base when teamBases is set', () => {
    const pm = new PlayerManager();
    // Ring of spawn points, bases at the two ends.
    pm.spawnPoints = [{ x: -70, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 70, y: 0, z: 0 }];
    pm.teamBases = { alpha: { x: -70, y: 0, z: 0 }, bravo: { x: 70, y: 0, z: 0 } };
    pm.addPlayer('a1', 'alpha'); // first spawn: no players yet, generic
    pm.addPlayer('b1', 'bravo');
    const a2 = pm.addPlayer('a2', 'alpha');
    // alpha base is at x=-70: a2 should spawn on the alpha side even
    // though b1 stands at +70.
    expect(a2.position.x).toBeLessThan(0);
  });
});
