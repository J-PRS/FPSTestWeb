import { describe, it, expect } from 'bun:test';
import { CombatHandler } from '../src/CombatHandler.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { Vec3 } from '../src/types.ts';
import type { RoomEventSink } from '../src/roomEvents.ts';

// Instant-attack origins are claim-driven: melee/LG/lance/repair send the
// eye point the shot left from, and the server trusts it only inside
// honest reach of the measured-uplink window (≤3m of a recorded body
// sample). Beyond that the origin clamps to history — no transit
// heuristic estimates where the shooter "probably" was.

function harness() {
  const players = new PlayerManager();
  const events: { type: string; pos?: Vec3 }[] = [];
  const sweeps: { origin: Vec3; range: number }[] = [];
  const emit: RoomEventSink = (e) => { if (e.type === 'meleeSweep') {events.push(e);} };
  const combat = new CombatHandler(players, () => {}, () => {}, {
    emit,
    beamSweep: (_id, muzzle, _dir, range) => { sweeps.push({ origin: muzzle, range }); return null; },
  });
  return { players, combat, events, sweeps };
}

const AT = { x: 0, y: 10, z: 0 };

describe('claim-driven instant origins', () => {
  it('melee sweep anchors at the claimed eye when it sits within honest reach', () => {
    const { players, combat, events } = harness();
    const p = players.addPlayer('p1');
    p.position = { ...AT };
    combat.handleShotFired('p1', {
      type: 'shotFired', weaponType: WeaponType.Melee,
      dir: { x: 0, y: 0, z: 1 },
      pos: { x: 1.5, y: 10, z: 0 }, // 1.5m off the body — honest muzzle
    });
    expect(events[0]?.pos).toEqual({ x: 1.5, y: 10, z: 0 });
  });

  it('a teleported claim clamps to the recorded body, not the lie', () => {
    const { players, combat, events } = harness();
    const p = players.addPlayer('p1');
    p.position = { ...AT };
    combat.handleShotFired('p1', {
      type: 'shotFired', weaponType: WeaponType.Melee,
      dir: { x: 0, y: 0, z: 1 },
      pos: { x: 100, y: 10, z: 0 },
    });
    expect(events[0]?.pos).toEqual(AT);
  });

  it('an LG tick sweeps from the claimed eye, not an estimated rewind', () => {
    const { players, combat, sweeps } = harness();
    const p = players.addPlayer('p1', undefined, 'none', 'light');
    p.position = { ...AT };
    combat.handleShotFired('p1', {
      type: 'shotFired', weaponType: WeaponType.Lightning,
      dir: { x: 0, y: 0, z: 1 },
      pos: { x: 2, y: 10.4, z: 0.8 },
    });
    expect(sweeps[0]?.origin).toEqual({ x: 2, y: 10.4, z: 0.8 });
  });

  it('a claimless intent (bot/legacy) falls back to the body pos', () => {
    const { players, combat, events } = harness();
    const p = players.addPlayer('p1');
    p.position = { ...AT };
    combat.handleShotFired('p1', {
      type: 'shotFired', weaponType: WeaponType.Melee,
      dir: { x: 0, y: 0, z: 1 },
    });
    expect(events[0]?.pos).toEqual(AT);
  });
});
