import { describe, it, expect } from 'bun:test';
import { CLASS_STATS } from '../../../shared/botClasses.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, firstPlayer, freeze } from './harness.ts';

describe('scenario: class/perk swaps bank on respawn', () => {
  it('classUpdate is invisible mid-life, applied at the new life', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const p = firstPlayer(room);
    // Spawn class follows the bot's kit now — the swap is what matters,
    // not which body the roster dealt it.
    const startClass = p.armorClass;
    const startMax = p.maxHealth;

    room.messages.handleMessage(p.id, { type: 'classUpdate', armorClass: 'heavy' });
    expect(p.armorClass).toBe(startClass); // nothing changes yet
    expect(p.pendingClass).toBe('heavy');
    expect(p.maxHealth).toBe(startMax); // no free heal mid-life

    const res = room.players.respawnPlayer(p.id);
    expect(res).not.toBeNull();
    expect(p.armorClass).toBe('heavy');
    expect(p.maxHealth).toBeGreaterThan(startMax);
    expect(p.pendingClass).toBeUndefined();
  });

  it('perkUpdate banks the same way — swapped at respawn, not mid-life', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    const basePerk = p.perk;
    room.messages.handleMessage(p.id, { type: 'perkUpdate', perk: 'regenerator' });
    expect(p.perk).toBe(basePerk);
    expect(p.pendingPerk).toBe('regenerator');
    room.players.respawnPlayer(p.id);
    expect(p.perk).toBe('regenerator');
    expect(p.pendingPerk).toBeUndefined();
  });
});

describe('scenario: reclaim applies the rejoiner class', () => {
  it('applyClaimedClass swaps the seat now, clamping health', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const p = firstPlayer(room);
    p.armorClass = 'medium';
    p.maxHealth = 100 + CLASS_STATS.medium.maxHealth;
    p.health = p.maxHealth;
    room.applyClaimedClass(p.id, 'heavy');
    expect(p.armorClass).toBe('heavy');
    expect(p.maxHealth).toBeGreaterThan(100 + CLASS_STATS.medium.maxHealth);
    expect(p.pendingClass).toBeUndefined();
    // Downgrade clamps current health to the smaller pool
    room.applyClaimedClass(p.id, 'light');
    expect(p.armorClass).toBe('light');
    expect(p.health).toBeLessThanOrEqual(p.maxHealth);
    // Bogus/unchanged claims are no-ops
    room.applyClaimedClass(p.id, 'bogus');
    expect(p.armorClass).toBe('light');
  });

  it('reclaim keeps the banked pick when reconciling a stale seat', () => {
    const room = mkRoom({ bots: 1 }, 'tdm');
    const p = firstPlayer(room);
    // Restart-restore blob left the seat on 'medium'; the rejoiner is
    // live-'light' with a 'heavy' swap banked (pendingClass). The claim
    // is the class being played — applying it must not consume the pick.
    p.armorClass = 'medium';
    p.pendingClass = 'heavy';
    room.applyClaimedClass(p.id, 'light');
    expect(p.armorClass).toBe('light');
    // Clearing pendingClass here enforced 'light' at respawn while the
    // client still banked 'heavy' — its heavy kit then reject-spammed.
    expect(p.pendingClass).toBe('heavy');
    const res = room.players.respawnPlayer(p.id);
    expect(res?.armorClass).toBe('heavy');
  });

  it('reclaim of the live class leaves light-only guns firing', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const p = firstPlayer(room);
    freeze(room, p.id, { x: 0, y: 31, z: 0 });
    const toP: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === p.id) {toP.push(m);} else {origSend(pid, m);} };
    const rejects = () => toP.filter((m) => m.type === 'shotRejected').length;

    // Live-light life, 'heavy' banked; seat blob says 'medium' (stale).
    // Pre-fix the handshake carried the PICK ('heavy') and this reclaim
    // flipped the seat early — every Lightning tick reject-spammed.
    p.armorClass = 'medium';
    p.pendingClass = 'heavy';
    room.applyClaimedClass(p.id, 'light'); // what the fixed client sends: appliedClass
    room.messages.handleMessage(p.id, {
      type: 'shotFired',
      dir: { x: 0, y: 0.3, z: 1 },
      weaponType: WeaponType.Lightning,
    });
    expect(rejects()).toBe(0);

    // The old claim (the banked pick) still locks the gun out — proving
    // the reject path itself is alive and this test isn't vacuous.
    room.applyClaimedClass(p.id, 'heavy');
    room.messages.handleMessage(p.id, {
      type: 'shotFired',
      dir: { x: 0, y: 0.3, z: 1 },
      weaponType: WeaponType.Lightning,
    });
    expect(rejects()).toBe(1);
  });
});
