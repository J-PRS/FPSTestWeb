import { describe, it, expect } from 'bun:test';
import { PlayerManager } from '../src/PlayerManager.ts';

describe('PlayerManager', () => {
  it('adds a player', () => {
    const pm = new PlayerManager();
    const player = pm.addPlayer('alice');
    expect(player.id).toBe('alice');
    expect(player.health).toBe(100);
    expect(player.isDead).toBe(false);
    expect(pm.getPlayerCount()).toBe(1);
  });

  it('removes a player', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice');
    const removed = pm.removePlayer('alice');
    expect(removed?.id).toBe('alice');
    expect(pm.getPlayerCount()).toBe(0);
  });

  it('applies damage correctly', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice');
    const result = pm.applyDamage('alice', 30);
    expect(result.killed).toBe(false);
    expect(result.newHealth).toBe(70);
  });

  it('kills player when health reaches 0', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice');
    const result = pm.applyDamage('alice', 100);
    expect(result.killed).toBe(true);
    expect(result.newHealth).toBe(0);
    const player = pm.getPlayer('alice');
    expect(player?.isDead).toBe(true);
  });

  it('does not damage dead players', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice');
    pm.applyDamage('alice', 100);
    const result = pm.applyDamage('alice', 50);
    expect(result.killed).toBe(false);
  });

  it('respawns a dead player', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice');
    pm.applyDamage('alice', 100);
    const result = pm.respawnPlayer('alice');
    expect(result).not.toBeNull();
    const player = pm.getPlayer('alice');
    expect(player?.isDead).toBe(false);
    expect(player?.health).toBe(100);
  });

  it('tracks kills', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice');
    pm.addPlayer('bob');
    pm.applyDamage('bob', 100);
    pm.addKill('alice');
    expect(pm.getPlayer('alice')?.kills).toBe(1);
    expect(pm.getPlayer('bob')?.deaths).toBe(1);
  });

  it('gets other players', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice');
    pm.addPlayer('bob');
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
});
