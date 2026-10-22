import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { Player } from '../entities/Player.js';
import { HudStats, type StatsHost } from '../ui/hud/hudStats.js';

function makeHost(): StatsHost {
  const names = [
    'health', 'energy', 'speed', 'speedH', 'speedV', 'kills', 'state',
    'ping', 'loss', 'jitter', 'fps', 'hitMarker', 'ghostBar', 'armor',
    'armorBar', 'buffsRow', 'healthBar', 'energyBar', 'dmgVignette',
    'dmgDir', 'dmgDirArc',
  ];
  return Object.assign(
    Object.fromEntries(names.map((name): [string, HTMLElement] => [name, document.createElement('div')])),
    { weaponSlots: [] },
  ) as unknown as StatsHost;
}

function makePlayer(health: number): Player {
  return {
    health, maxHealth: 100, isDead: false, armor: 0, energy: 60,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0,
    kills: 0, onGround: true, loadout: [0], weaponIndex: 0,
    buffUntil: { regen: 0, dd: 0, shield: 0 },
    getSpeed: (): number => 0,
  } as unknown as Player;
}

describe('HUD health ghost', (): void => {
  it('starts at restored partial health without inventing damage', (): void => {
    const host = makeHost();
    const stats = new HudStats(host);
    stats.tick(0, makePlayer(60));
    expect(host.healthBar.style.transform).toBe('scaleX(0.6)');
    expect(host.ghostBar.style.transform).toBe('scaleX(0)');
  });

  it('still trails real damage after the first sample', (): void => {
    const host = makeHost();
    const stats = new HudStats(host);
    const player = makePlayer(60);
    stats.tick(0, player);
    player.health = 40;
    stats.tick(0, player);
    expect(host.healthBar.style.transform).toBe('scaleX(0.4)');
    expect(host.ghostBar.style.transform).toBe('translateX(40%) scaleX(0.2)');
    stats.tick(0.25, player);
    expect(host.ghostBar.style.transform).toBe('translateX(40%) scaleX(0.1)');
  });

  it('snaps to partial health on revival', (): void => {
    const host = makeHost();
    const stats = new HudStats(host);
    const player = makePlayer(100);
    stats.tick(0, player);
    player.health = 0;
    player.isDead = true;
    stats.tick(0, player);
    player.health = 40;
    player.isDead = false;
    stats.tick(0, player);
    expect(host.healthBar.style.transform).toBe('scaleX(0.4)');
    expect(host.ghostBar.style.transform).toBe('scaleX(0)');
  });

  it('snaps the ghost on healing rather than leaving a damage trail', (): void => {
    const host = makeHost();
    const stats = new HudStats(host);
    const player = makePlayer(60);
    stats.tick(0, player);
    player.health = 80;
    stats.tick(0, player);
    expect(host.healthBar.style.transform).toBe('scaleX(0.8)');
    expect(host.ghostBar.style.transform).toBe('scaleX(0)');
  });
});
