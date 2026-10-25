import { describe, it, expect } from 'bun:test';
import { PlayerManager } from '../src/PlayerManager.ts';
import { STATUS } from '../../shared/status.ts';

describe('PlayerManager', () => {
  it('adds a player', () => {
    const pm = new PlayerManager();
    const player = pm.addPlayer('alice'); pm.breakShield('alice');
    expect(player.id).toBe('alice');
    expect(player.health).toBe(125);
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
    expect(result.newHealth).toBe(95);
  });

  it('energy shield absorbs hits without touching health', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    pm.getPlayer('alice')!.status = STATUS.SHIELD;
    const result = pm.applyDamage('alice', 50);
    expect(result.killed).toBe(false);
    expect(result.newHealth).toBe(125);
    // Flag off → damage lands normally
    pm.getPlayer('alice')!.status = 0;
    expect(pm.applyDamage('alice', 50).newHealth).toBe(75);
  });

  it('death clears the shield flag', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    // Kill once to establish the flag is unset on death, then flag back on
    pm.applyDamage('alice', 150);
    const p = pm.getPlayer('alice')!;
    p.status = STATUS.SHIELD;
    pm.respawnPlayer('alice');
    expect(p.status & STATUS.SHIELD).toBe(0);
  });

  it('death clears the medkit flag', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    const p = pm.getPlayer('alice')!;
    p.status = STATUS.MEND;
    pm.applyDamage('alice', 200);
    expect(p.status).toBe(0);
  });

  it('plated perk resists damage, lifesteal leaves the health cap alone', () => {
    const pm = new PlayerManager();
    pm.addPlayer('tank', undefined, 'armored');
    pm.addPlayer('tough', undefined, 'lifesteal');
    pm.breakShield('tank'); pm.breakShield('tough');
    // Underdog plate: full-health hits punch straight through…
    expect(pm.applyDamage('tank', 40).newHealth).toBe(85);
    // …resist kicks in only below 20% max HP (125 → 25).
    expect(pm.applyDamage('tank', 40).newHealth).toBe(45);
    expect(pm.applyDamage('tank', 30).newHealth).toBe(15); // still above the line going in — full hit
    expect(pm.applyDamage('tank', 10).newHealth).toBe(9);  // 15 - 10*0.6 — underdog plate active
    expect(pm.getPlayer('tough')!.health).toBe(125);        // 100 + 25 — perks don't touch the pool
  });

  it('invulnerable (intermission godmode) blocks every damage path', () => {
    const pm = new PlayerManager();
    pm.addPlayer('p1');
    pm.breakShield('p1');
    pm.invulnerable = true;
    expect(pm.applyDamage('p1', 40).newHealth).toBe(125);
    expect(pm.applyDamage('p1', 999).killed).toBe(false);
    pm.invulnerable = false;
    expect(pm.applyDamage('p1', 40).newHealth).toBe(85);
  });

  it('kills player when health reaches 0', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    const result = pm.applyDamage('alice', 150);
    expect(result.killed).toBe(true);
    expect(result.newHealth).toBe(0);
    const player = pm.getPlayer('alice');
    expect(player?.isDead).toBe(true);
  });

  it('spawn shield blocks damage until it expires or is broken', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice');
    expect(pm.applyDamage('alice', 30).newHealth).toBe(125); // shielded
    pm.breakShield('alice');
    expect(pm.applyDamage('alice', 30).newHealth).toBe(95);
    // Respawn re-arms the shield
    pm.applyDamage('alice', 150);
    pm.respawnPlayer('alice');
    expect(pm.applyDamage('alice', 30).newHealth).toBe(125);
  });

  it('does not damage dead players', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    pm.applyDamage('alice', 150);
    const result = pm.applyDamage('alice', 50);
    expect(result.killed).toBe(false);
  });

  it('respawns a dead player', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    pm.applyDamage('alice', 150);
    const result = pm.respawnPlayer('alice');
    expect(result).not.toBeNull();
    const player = pm.getPlayer('alice');
    expect(player?.isDead).toBe(false);
    expect(player?.health).toBe(125);
  });

  it('applies a banked classUpdate only on respawn', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice', undefined, 'none', 'medium');
    pm.breakShield('alice');
    const mediumHp = pm.getPlayer('alice')!.maxHealth;
    // Mid-life the pick is banked, not applied — no free heal mid-fight.
    pm.getPlayer('alice')!.pendingClass = 'heavy';
    expect(pm.getPlayer('alice')!.armorClass).toBe('medium');
    expect(pm.getPlayer('alice')!.maxHealth).toBe(mediumHp);
    pm.applyDamage('alice', 150);
    const result = pm.respawnPlayer('alice')!;
    expect(result.armorClass).toBe('heavy');
    const p = pm.getPlayer('alice')!;
    expect(p.maxHealth).toBeGreaterThan(mediumHp);
    expect(p.health).toBe(p.maxHealth);
    expect(p.pendingClass).toBeUndefined();
  });

  it('tracks kills', () => {
    const pm = new PlayerManager();
    pm.addPlayer('alice'); pm.breakShield('alice');
    pm.addPlayer('bob'); pm.breakShield('bob');
    pm.applyDamage('bob', 150);
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

  it('unaffiliated ids keep the own-base pull — a Room-installed spawnHomeBias returning undefined must not mask the flat-pool fallback', () => {
    const pm = new PlayerManager();
    pm.spawnPoints = [{ x: -70, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 70, y: 0, z: 0 }];
    pm.teamBases = { alpha: { x: -70, y: 0, z: 0 }, bravo: { x: 70, y: 0, z: 0 } };
    // Room wires this for the bot roster; a 0/undefined-returning human
    // used to collapse the picker's `?? (teamPool ? 0 : 2)` fallback to 0,
    // making scoring pure foe-clearance (bastion far-base spawns).
    pm.spawnHomeBias = () => undefined;
    pm.addPlayer('a1', 'alpha');
    pm.addPlayer('b1', 'bravo');
    const b1 = pm.getPlayer('b1')!;
    // Enemy camps alpha's base — clearance-only scoring would push the
    // next alpha join to bravo's side 140m from his flag.
    b1.position.x = -70; b1.position.z = 0;
    const a2 = pm.addPlayer('a2', 'alpha');
    expect(a2.position.x).toBeLessThan(0);
  });
});
